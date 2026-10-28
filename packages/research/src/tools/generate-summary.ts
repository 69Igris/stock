/**
 * Generate Summary - One-paragraph executive summary
 */

import { getGeminiModel, generateWithTimeout } from "@usemoney/core/gemini";
import { getSummaryPrompt } from "../prompts";
import type { ResearchToolDef, ToolOutput } from "./types";

export const generateSummaryTool: ResearchToolDef = {
  name: "generate_summary",
  description:
    "Generate a one-paragraph executive summary of a research report",
  category: "synthesis",
  parameters: {
    report: { type: "string", description: "Full report text", required: true },
  },
  execute: async (params): Promise<ToolOutput> => {
    const report = params.report as string;
    if (!report) return { success: false, error: "report is required" };

    try {
      const model = getGeminiModel("fast");
      const prompt = getSummaryPrompt(report);
      const summary = await generateWithTimeout(model, prompt, 15000);

      return { success: true, data: { summary } };
    } catch (error) {
      return {
        success: false,
        error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
