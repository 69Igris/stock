/**
 * Gemini LLM Integration - Action Detection and Parsing
 *
 * This file handles detection and extraction of actionable commands
 * from LLM responses, enabling users to perform operations via chat.
 */

import { geminiLogger as logger } from "@usemoney/logger";
import type {
  DetectedAction,
  ActionValidationResult,
  ActionType,
} from "@usemoney/types";

/**
 * Regex patterns for detecting actions in LLM responses
 *
 * Format: ACTION: action_type { param1: "value1", param2: 123, ... }
 */
const ACTION_PATTERNS: Record<ActionType, RegExp> = {
  create_scenario: /ACTION:\s*create_scenario\s*\{([^}]+)\}/i,
  modify_scenario: /ACTION:\s*modify_scenario\s*\{([^}]+)\}/i,
  delete_scenario: /ACTION:\s*delete_scenario\s*\{([^}]+)\}/i,
  add_stock: /ACTION:\s*add_stock\s*\{([^}]+)\}/i,
  add_mutual_fund: /ACTION:\s*add_mutual_fund\s*\{([^}]+)\}/i,
  remove_holding: /ACTION:\s*remove_holding\s*\{([^}]+)\}/i,
  save_analysis: /ACTION:\s*save_analysis\s*\{([^}]+)\}/i,
};

/**
 * Required parameters for each action type
 */
const REQUIRED_PARAMS: Record<ActionType, string[]> = {
  create_scenario: ["name", "retirementAge", "currentAge", "currentCorpus"],
  modify_scenario: ["name"],
  delete_scenario: ["name"],
  add_stock: ["symbol", "quantity", "buyPrice"],
  add_mutual_fund: ["schemeName", "units", "nav"],
  remove_holding: ["symbol"],
  save_analysis: ["symbol", "recommendation"],
};

/**
 * Detect actions in LLM response
 *
 * Scans the response for ACTION markers and extracts parameters
 *
 * @param response - LLM's response text
 * @param pagePath - Current page path for validation
 * @returns Detected action or null if no action found
 */
export function detectActions(
  response: string,
  pagePath: string
): DetectedAction | null {
  // Check each action pattern
  for (const [actionType, pattern] of Object.entries(ACTION_PATTERNS)) {
    const match = response.match(pattern);

    if (match) {
      try {
        // Extract parameter string
        const paramsStr = match[1].trim();

        // Parse parameters
        const parameters = parseActionParameters(paramsStr);

        // Generate confirmation message
        const confirmationMessage = generateConfirmationMessage(
          actionType as ActionType,
          parameters
        );

        logger.info(
          {
            actionType,
            parameters,
            pagePath,
          },
          "Action detected in response"
        );

        return {
          type: actionType as ActionType,
          parameters,
          confirmationMessage,
        };
      } catch (error) {
        logger.error(
          {
            error,
            actionType,
            match: match[0],
          },
          "Failed to parse action parameters"
        );
        // Continue checking other patterns
      }
    }
  }

  return null;
}

/**
 * Parse action parameters from string
 *
 * Converts "key: value, key2: value2" format to object
 * Handles strings, numbers, arrays, and nested objects
 * Exported (used by detectActions) for unit testing the parser.
 *
 * @param paramsStr - Parameter string from action
 * @returns Parsed parameters object
 */
export function parseActionParameters(paramsStr: string): Record<string, any> {
  try {
    // Convert to valid JSON format
    // Handle both key: value and "key": "value" formats
    const jsonStr = `{${paramsStr}}`
      .replace(/(\w+):/g, '"$1":') // Add quotes to keys
      .replace(/:\s*"([^"]*)"/g, ': "$1"') // Keep existing string quotes
      .replace(/:\s*([^",}\]]+)/g, (match, value) => {
        // Handle numbers and booleans
        const trimmed = value.trim();
        if (
          trimmed === "true" ||
          trimmed === "false" ||
          !isNaN(Number(trimmed))
        ) {
          return `: ${trimmed}`;
        }
        // Quote unquoted strings
        return `: "${trimmed}"`;
      });

    const parsed = JSON.parse(jsonStr);

    logger.debug({ paramsStr, parsed }, "Parsed action parameters");

    return parsed;
  } catch (error) {
    logger.error(
      { error, paramsStr },
      "Failed to parse action parameters as JSON"
    );
    throw new Error(`Invalid action parameters: ${paramsStr}`);
  }
}

/**
 * Generate user-friendly confirmation message.
 * Exported (used by detectActions) for unit testing the confirmation copy.
 *
 * @param actionType - Type of action
 * @param params - Action parameters
 * @returns Confirmation message to display
 */
export function generateConfirmationMessage(
  actionType: ActionType,
  params: Record<string, any>
): string {
  const messages: Record<ActionType, (p: any) => string> = {
    create_scenario: (p) =>
      `Create new FIRE scenario "${p.name}" with retirement age ${p.retirementAge}?`,

    modify_scenario: (p) => `Modify FIRE scenario "${p.name}"?`,

    delete_scenario: (p) =>
      `Delete FIRE scenario "${p.name}"? This action cannot be undone.`,

    add_stock: (p) =>
      `Add ${p.quantity} shares of ${p.symbol} at ₹${p.buyPrice}${p.buyDate ? ` (purchased on ${p.buyDate})` : ""}?`,

    add_mutual_fund: (p) =>
      `Add ${p.units} units of ${p.schemeName} at NAV ₹${p.nav}${p.purchaseDate ? ` (purchased on ${p.purchaseDate})` : ""}?`,

    remove_holding: (p) =>
      `Remove ${p.symbol} from your holdings? This will delete the position from your portfolio.`,

    save_analysis: (p) =>
      // MONEY-457: Removed the `${p.recommendation}` interpolation (BUY/
      // HOLD/SELL) and the "target price ₹X" suffix from the confirm
      // copy. UseMoney is not SEBI-registered as a Research Analyst, so
      // labelled recommendations and price targets are not surfaced to
      // the user. The saved analysis still stores observation-only
      // strengths / weaknesses / commentary.
      `Save analysis for ${p.symbol}?`,
  };

  const generator = messages[actionType];
  return generator ? generator(params) : "Confirm this action?";
}

/**
 * Validate action parameters
 *
 * Checks if all required parameters are present and valid
 *
 * @param actionType - Type of action
 * @param params - Parameters to validate
 * @returns Validation result
 */
export function validateActionParameters(
  actionType: ActionType,
  params: Record<string, any>
): ActionValidationResult {
  const required = REQUIRED_PARAMS[actionType] || [];
  const errors: string[] = [];

  // Check required fields
  const missing = required.filter((field) => !(field in params));
  if (missing.length > 0) {
    errors.push(`Missing required fields: ${missing.join(", ")}`);
  }

  // Type-specific validation
  switch (actionType) {
    case "create_scenario":
    case "modify_scenario":
      if (params.retirementAge && params.retirementAge < 18) {
        errors.push("Retirement age must be at least 18");
      }
      if (params.currentAge && params.currentAge < 18) {
        errors.push("Current age must be at least 18");
      }
      if (
        params.retirementAge &&
        params.currentAge &&
        params.retirementAge <= params.currentAge
      ) {
        errors.push("Retirement age must be greater than current age");
      }
      if (params.currentCorpus && params.currentCorpus < 0) {
        errors.push("Current corpus cannot be negative");
      }
      break;

    case "add_stock":
      if (params.quantity && params.quantity <= 0) {
        errors.push("Quantity must be greater than 0");
      }
      if (params.buyPrice && params.buyPrice <= 0) {
        errors.push("Buy price must be greater than 0");
      }
      if (params.symbol && !/^[A-Z0-9]+$/.test(params.symbol)) {
        errors.push("Symbol must contain only uppercase letters and numbers");
      }
      break;

    case "add_mutual_fund":
      if (params.units && params.units <= 0) {
        errors.push("Units must be greater than 0");
      }
      if (params.nav && params.nav <= 0) {
        errors.push("NAV must be greater than 0");
      }
      break;

    case "save_analysis":
      // MONEY-457: Recommendation MUST be "N/A" — UseMoney is not
      // SEBI-registered as a Research Analyst, so labelled BUY/HOLD/SELL
      // verdicts and price targets are forbidden. We accept either
      // "N/A" or an absent field; anything else is dropped to "N/A" at
      // the call site upstream and flagged here so callers know.
      if (
        params.recommendation &&
        params.recommendation.toUpperCase() !== "N/A"
      ) {
        errors.push(
          'Recommendation must be "N/A" (UseMoney does not surface BUY/SELL/HOLD verdicts)'
        );
      }
      if (params.targetPrice) {
        errors.push(
          "Target price is not supported (UseMoney does not surface price targets)"
        );
      }
      if (params.stopLoss) {
        errors.push(
          "Stop loss is not supported (UseMoney does not surface stop-loss levels)"
        );
      }
      break;
  }

  if (errors.length > 0) {
    logger.warn({ actionType, params, errors }, "Action validation failed");
    return { valid: false, errors };
  }

  logger.info({ actionType, params }, "Action validation passed");
  return { valid: true };
}

/**
 * Sanitize action parameters
 *
 * Removes potentially dangerous characters and normalizes data
 *
 * @param params - Parameters to sanitize
 * @returns Sanitized parameters
 */
export function sanitizeActionParams(
  params: Record<string, any>
): Record<string, any> {
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      // Remove script tags and dangerous HTML
      sanitized[key] = value
        .replace(/<script[^>]*>.*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, "")
        .trim();
    } else if (typeof value === "number") {
      // Ensure valid number
      sanitized[key] = isNaN(value) ? 0 : value;
    } else if (Array.isArray(value)) {
      // Sanitize array elements
      sanitized[key] = value.map((item) =>
        typeof item === "string"
          ? item.replace(/<script[^>]*>.*?<\/script>/gi, "").trim()
          : item
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Remove action markers from response text
 *
 * Cleans the response for display to user. Handles both legacy ACTION: markers
 * and new :::block:action markers.
 *
 * @param response - LLM response with action markers
 * @returns Clean response without action markers
 */
export function removeActionMarkers(response: string): string {
  return (
    response
      .replace(/ACTION:\s*\w+\s*\{[^}]+\}/gi, "")
      // Match the whole TOOL_CALL JSON object, tolerating ONE level of nested
      // braces (real payloads always carry a `params: { … }` object). A bare
      // `\{[\s\S]*?\}` stops at the first inner `}` and leaves a dangling `}`
      // in the user-facing text — this balanced form fixes that.
      .replace(/TOOL_CALL:\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
      .trim()
  );
}

/**
 * Check if page supports actions
 *
 * @param pagePath - Page path to check
 * @returns true if page supports chat actions
 */
export function pageSupportsActions(pagePath: string): boolean {
  const actionPages = ["/fire", "/holdings", "/analysis"];
  return actionPages.includes(pagePath);
}
