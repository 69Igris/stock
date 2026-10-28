/**
 * Parameter Extractor
 *
 * Extracts and validates tool parameters using Zod schemas.
 * Returns clarifying question if required params are missing.
 */

import { getTool } from "./registry";
// De-shadowed (MONEY-620): the pure Zod validation lives in
// param-extractor-logic.ts so it can be unit-tested without the registry's
// react.cache chain. Re-export the shared result type for existing importers.
import {
  validateParamsAgainstSchema,
  type ParamExtractionResult,
} from "./param-extractor-logic";

export type { ParamExtractionResult } from "./param-extractor-logic";

/**
 * Extract and validate parameters for a tool
 */
export function extractAndValidateParams(
  toolName: string,
  rawParams: Record<string, unknown>
): ParamExtractionResult {
  const tool = getTool(toolName);
  if (!tool) {
    return {
      success: false,
      clarifyingQuestion:
        "I don't recognize that action. Could you rephrase your request?",
    };
  }

  return validateParamsAgainstSchema(tool.parameters, rawParams);
}
