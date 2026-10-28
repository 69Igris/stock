import { getVertexAIClient, isGeminiEnabled } from "@usemoney/core/gemini";
import type { GenerateContentOptions } from "./types";

/**
 * Generate learning content using Gemini AI
 */
export async function generateLearningContent(
  options: GenerateContentOptions,
): Promise<string> {
  if (!isGeminiEnabled()) {
    throw new Error("Gemini AI is not enabled. Set USE_GEMINI=true.");
  }

  const { topic, contentType, language = "English", rawMaterials } = options;

  const client = getVertexAIClient();
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  });

  const prompt = buildContentPrompt(topic, contentType, language, rawMaterials);

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("No content generated from Gemini");
  }

  return text;
}

function buildContentPrompt(
  topic: string,
  contentType: string,
  language: string,
  rawMaterials?: string,
): string {
  const formatGuide = getFormatGuide(contentType);

  let prompt = `You are an expert financial educator specializing in Indian stock markets (NSE, BSE), SEBI regulations, and investment strategies.

Generate a comprehensive ${contentType} about "${topic}" in ${language}.

${formatGuide}

Requirements:
1. Use Indian market context - reference SEBI, NSE/BSE, Indian companies, INR values
2. Include practical, actionable advice
3. Write in a clear, educational tone suitable for retail investors
4. Structure content with proper headings, sections, and examples
5. Include relevant data points, statistics, or case studies
6. End with key takeaways or summary points`;

  if (rawMaterials) {
    prompt += `\n\nReference Materials:\n${rawMaterials}`;
  }

  return prompt;
}

function getFormatGuide(contentType: string): string {
  switch (contentType) {
    case "article":
      return "Format as a well-structured markdown article with headings (##), bullet points, and bold text for emphasis. Target 1500-2500 words.";
    case "video":
      return "Format as a video script with sections: [INTRO], [MAIN CONTENT] with numbered points, [EXAMPLES], [SUMMARY]. Include speaker notes and visual cue suggestions.";
    case "audio":
      return "Format as a podcast-style script with conversational tone. Include [INTRO], [DISCUSSION POINTS], [LISTENER TAKEAWAYS]. Target 10-15 minutes of speaking.";
    case "infographic":
      return "Format as structured data points for an infographic. Include: title, subtitle, 5-7 key statistics, 3-4 comparison blocks, and a conclusion statement.";
    default:
      return "Format as a well-structured markdown document.";
  }
}
