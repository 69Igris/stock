/**
 * Layer 2: Output Validation
 *
 * Validates LLM output: parses tool calls, fact-checks numbers,
 * appends disclaimers for financial recommendations.
 *
 * The side-effect-free checks (filterUnsafeContent, detectDisclaimers,
 * factCheckNumbers, stripLeakedJson) live in `./output-validator-logic` so
 * they can be unit-tested under `node:test` without importing the chat-tool
 * registry → server actions → `lib/auth.ts` (`react.cache`) chain. This module
 * keeps `validateOutput`, the only part that needs the registry (`getTool`,
 * `extractAndValidateParams`), and re-exports the pure logic so existing
 * importers keep working.
 */

import { parseToolCalls, removeToolCallMarkers } from "./intent-mapper";
import type { IntentMatch } from "./intent-mapper";
import { getTool } from "./registry";
import { extractAndValidateParams } from "./param-extractor";
import {
  detectDisclaimers,
  factCheckNumbers,
  filterUnsafeContent,
  stripLeakedJson,
} from "./output-validator-logic";

// Re-export the pure, side-effect-free checks so existing importers
// (e.g. lib/chat-tools/index.ts, app/api/chat/route.ts) and the unit tests
// can pull them from either entry point.
export {
  detectDisclaimers,
  factCheckNumbers,
  filterUnsafeContent,
  stripLeakedJson,
} from "./output-validator-logic";

export interface OutputValidationResult {
  cleanedResponse: string;
  toolCalls: IntentMatch[];
  disclaimers: string[];
}

/**
 * Validate and process LLM output
 */
export function validateOutput(response: string): OutputValidationResult {
  // 1. Parse TOOL_CALL blocks from response
  const toolCalls = parseToolCalls(response);

  // 2. Validate each tool call
  const validToolCalls = toolCalls.filter((tc) => {
    const tool = getTool(tc.tool);
    if (!tool) return false;

    const validation = extractAndValidateParams(tc.tool, tc.params);
    return validation.success;
  });

  // 3. Remove tool call markers from display text
  let cleanedResponse = removeToolCallMarkers(response);

  // 3.5. Strip leaked JSON fragments (Gemini sometimes outputs raw filter/param JSON inline)
  cleanedResponse = stripLeakedJson(cleanedResponse);

  // 4. Filter unsafe content
  cleanedResponse = filterUnsafeContent(cleanedResponse);

  // 5. Detect financial recommendations and add disclaimers
  const disclaimers = detectDisclaimers(cleanedResponse);

  return {
    cleanedResponse,
    toolCalls: validToolCalls,
    disclaimers,
  };
}
