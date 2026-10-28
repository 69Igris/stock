/**
 * StockSage Research Validator
 *
 * Uses Gemini Pro to quality-check the research report.
 */

import { generateWithTimeout, estimateTokenCount } from "@usemoney/core/gemini";
import { getValidatorPrompt, buildValidatorUserPrompt } from "./prompts";
import { parseValidationResponse } from "./validator-logic";
import { getResearchModel } from "./model-selection";
import type { ValidationResult, ResearchPlan } from "./types";
import type { Scratchpad } from "./scratchpad";

export class ResearchValidator {
  /**
   * Validate a research report for quality and completeness.
   *
   * @param model - MONEY-587 (task #36) optional user-chosen Gemini
   *   registry model id. When supplied (and usable) the quality check
   *   runs on the same model the user paid the premium for; otherwise it
   *   falls back to the advanced config (2.5-pro).
   */
  async validate(
    query: string,
    plan: ResearchPlan,
    report: string,
    scratchpad: Scratchpad,
    model?: string,
  ): Promise<ValidationResult> {
    try {
      const validatorModel = getResearchModel(model);
      const systemPrompt = getValidatorPrompt();
      const userPrompt = buildValidatorUserPrompt(query, plan, report);

      const inputTokens = estimateTokenCount(systemPrompt + userPrompt);

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
      const response = await generateWithTimeout(
        validatorModel,
        fullPrompt,
        30000,
        2,
      );

      const outputTokens = estimateTokenCount(response);

      scratchpad.log(
        "validation",
        {
          rawResponse: response,
        },
        undefined,
        { input: inputTokens, output: outputTokens },
      );

      return parseValidationResponse(response);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      scratchpad.log("error", { phase: "validation", error: errorMsg });
      console.warn("[validator] validation failed, defaulting to pass", {
        errorMsg,
      });

      // Validation couldn't run. Do NOT fabricate a passing 0.7 quality stamp
      // (MONEY-612 trust) — that also silently bypasses the SEBI compliance gate
      // in the validator prompt. Return an honest, un-passed result with a
      // neutral score. Gaps is empty, so the refine loop has nothing actionable
      // and exits; the report still ships, just never falsely marked "verified".
      return {
        score: 0.5,
        passed: false,
        gaps: [],
        suggestions: [`Quality validation could not run: ${errorMsg}`],
      };
    }
  }
}
