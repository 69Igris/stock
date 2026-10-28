import { getVertexAIClient, isGeminiEnabled } from "@usemoney/core/gemini";
import type { ContentVerificationResult, VerifyContentOptions } from "./types";

/**
 * Verify content quality using Gemini AI
 * Returns a score (0-10), checks, and suggestions
 */
export async function verifyContent(
  options: VerifyContentOptions,
): Promise<ContentVerificationResult> {
  if (!isGeminiEnabled()) {
    throw new Error("Gemini AI is not enabled. Set USE_GEMINI=true.");
  }

  const { content, topic, contentType, language = "English" } = options;

  const client = getVertexAIClient();
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  });

  const prompt = `You are a content quality reviewer specializing in Indian financial education.

Review the following ${contentType} about "${topic}" written in ${language}.

Content to review:
---
${content.slice(0, 6000)}
---

Evaluate the content on these 6 criteria and return a JSON response:

1. **Factual Accuracy** - Are SEBI rules, NSE/BSE info, settlement cycles, and regulations correct?
2. **Content Completeness** - Does it adequately cover the topic?
3. **Tone & Language** - Is it written properly in ${language} with appropriate educational tone?
4. **Indian Market Context** - Does it use India-specific examples, companies, and terminology?
5. **Structure & Flow** - Is it well-organized with clear sections and logical progression?
6. **Actionable Value** - Does it provide practical, actionable information?

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "score": <number 1-10>,
  "checks": [
    { "label": "Factual Accuracy", "status": "pass|warn|fail", "detail": "<brief explanation>" },
    { "label": "Content Completeness", "status": "pass|warn|fail", "detail": "<brief explanation>" },
    { "label": "Tone & Language", "status": "pass|warn|fail", "detail": "<brief explanation>" },
    { "label": "Indian Market Context", "status": "pass|warn|fail", "detail": "<brief explanation>" },
    { "label": "Structure & Flow", "status": "pass|warn|fail", "detail": "<brief explanation>" },
    { "label": "Actionable Value", "status": "pass|warn|fail", "detail": "<brief explanation>" }
  ],
  "suggestions": ["<improvement suggestion 1>", "<improvement suggestion 2>", ...]
}`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("No verification response from Gemini");
  }

  // Parse JSON from response, handling potential markdown code blocks
  const jsonStr = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const parsed = JSON.parse(jsonStr) as ContentVerificationResult;

  return parsed;
}
