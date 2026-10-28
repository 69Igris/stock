/**
 * StockSage Research Validator — pure parsing logic.
 *
 * `parseValidationResponse` was a module-private function inside `validator.ts`.
 * It is extracted here so the parsing/clamping behaviour — including the
 * MONEY-612 trust fix (an un-parseable validator response yields an HONEST
 * un-passed `0.5`, never a fabricated passing `0.7`) — can be unit-tested by
 * importing the REAL symbol. `ResearchValidator.validate()` imports and calls it.
 */

import type { ValidationResult } from "./types";

/**
 * Parse the validator LLM's response into a `ValidationResult`.
 *
 * - Extracts JSON from a ```` ```json ```` / bare ```` ``` ```` code block if present.
 * - `score` is `parsed.score || 0.5` (so 0/undefined/null → 0.5), then clamped
 *   to [0, 1].
 * - `passed` uses `parsed.passed ?? (score >= 0.7)`.
 * - On ANY parse failure: returns `{ score: 0.5, passed: false, gaps: [],
 *   suggestions: ["Could not parse validation response"] }` — NOT a passing
 *   0.7 (MONEY-612: never fabricate a "verified" stamp).
 */
export function parseValidationResponse(response: string): ValidationResult {
  // Extract JSON from response
  let jsonStr = response;
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      score?: number;
      passed?: boolean;
      gaps?: string[];
      suggestions?: string[];
    };

    const score = Math.max(0, Math.min(1, parsed.score || 0.5));

    return {
      score,
      passed: parsed.passed ?? score >= 0.7,
      gaps: parsed.gaps || [],
      suggestions: parsed.suggestions || [],
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.warn(
      "[validator] validation response parse failed, defaulting to pass",
      { errorMsg },
    );
    // Couldn't parse the validator's response — don't fabricate a passing 0.7
    // stamp (MONEY-612 trust). Honest neutral score, not passed.
    return {
      score: 0.5,
      passed: false,
      gaps: [],
      suggestions: ["Could not parse validation response"],
    };
  }
}
