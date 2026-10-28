/**
 * Layer 1: Input Validation
 *
 * Sanitization + injection detection + fast intent classification.
 * Topic validation is handled by the LLM system prompt (not regex).
 */

import { sanitizeUserInput, detectPromptInjection } from "@usemoney/core";
import { classifyIntentFast, type IntentMatch } from "./intent-mapper";
import { getTool } from "./registry";
import type { ChatContextModeSerializable } from "@usemoney/types";
// De-shadowed (MONEY-620): the pure context-permission helpers live in
// input-validator-logic.ts so they can be unit-tested without the registry's
// react.cache chain.
import {
  parseContextKey,
  isToolAllowedInContext as isToolAllowedInContextByScope,
} from "./input-validator-logic";

export interface InputValidationResult {
  valid: boolean;
  sanitizedMessage: string;
  reason?: string;
  blocked?: boolean;
  fastIntent?: IntentMatch;
}

/**
 * Validate and classify user input before sending to LLM.
 *
 * Only blocks prompt injection attempts. Topic validation is delegated
 * to Flash (for ambiguous queries) and the system prompt guardrails
 * (which politely decline non-finance topics). This avoids false
 * rejections on short finance queries like "What is RSI".
 */
export async function validateInput(
  message: string,
  context?: ChatContextModeSerializable
): Promise<InputValidationResult> {
  // 1. Sanitize input (length limits, role marker removal)
  const sanitizedMessage = sanitizeUserInput(message);

  // 2. Block prompt injection attempts
  if (detectPromptInjection(sanitizedMessage)) {
    return {
      valid: false,
      sanitizedMessage,
      reason:
        "Your query contains patterns that are not allowed. Please ask a straightforward finance question.",
      blocked: true,
    };
  }

  // 3. Fast intent classification (regex-based, ~80% of queries)
  const fastIntent = classifyIntentFast(sanitizedMessage);

  // 4. Context permission check (if intent matched)
  if (fastIntent && context) {
    const contextKey = parseContextKey(context);
    if (!isToolAllowedInContextByScope(getTool(fastIntent.tool), contextKey)) {
      // Don't block - just clear the fast intent so it goes through LLM
      return {
        valid: true,
        sanitizedMessage,
        fastIntent: undefined,
      };
    }
  }

  return {
    valid: true,
    sanitizedMessage,
    fastIntent: fastIntent || undefined,
  };
}
