/**
 * Parameter Extractor - pure logic
 *
 * The Zod validation + clarifying-question derivation lives here, decoupled
 * from the tool registry (which pulls server actions → `react.cache` and cannot
 * load in a bare Node test). `param-extractor.ts` resolves the tool's schema via
 * `getTool` and then calls `validateParamsAgainstSchema`, so production and the
 * unit tests run the SAME validation code (no shadow).
 *
 * NOTE (Zod v4): issue objects do NOT carry a `received` property, so the
 * `"received" in issue` guard below is always false. Missing required fields
 * therefore fall through to the generic "Invalid parameters" path rather than a
 * dedicated "I need more information" path. This is intentional — the tests pin
 * this exact behavior so a Zod upgrade that changes it is caught.
 */

import type { z } from "zod";

export interface ParamExtractionResult {
  success: boolean;
  params?: Record<string, unknown>;
  missingFields?: string[];
  clarifyingQuestion?: string;
}

/**
 * Validate raw params against a tool's Zod schema and shape the result into a
 * ParamExtractionResult (with a user-facing clarifying question on failure).
 */
export function validateParamsAgainstSchema(
  schema: z.ZodSchema,
  rawParams: Record<string, unknown>
): ParamExtractionResult {
  const result = schema.safeParse(rawParams);

  if (result.success) {
    return { success: true, params: result.data as Record<string, unknown> };
  }

  // Collect missing/invalid fields. (See header note: under Zod v4 the
  // `"received" in i` guard is always false, so this stays empty in practice.)
  const issues = result.error.issues;
  const missingFields = issues
    .filter(
      (i) =>
        i.code === "invalid_type" &&
        "received" in i &&
        (i as Record<string, unknown>).received === "undefined"
    )
    .map((i) => i.path.join("."));

  if (missingFields.length > 0) {
    return {
      success: false,
      missingFields,
      clarifyingQuestion: `I need more information. Please provide: ${missingFields.join(", ")}`,
    };
  }

  // Other validation errors
  const errorMessages = issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  return {
    success: false,
    clarifyingQuestion: `Invalid parameters: ${errorMessages.join("; ")}`,
  };
}
