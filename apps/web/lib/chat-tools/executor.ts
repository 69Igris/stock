/**
 * Tool Executor
 *
 * Pipeline: validate params → check confirmation → execute server action → format result.
 * Error messages are sanitized to avoid leaking internal details (stack traces,
 * DB connection strings, etc.) to the user.
 */

import type { ToolResult } from "@usemoney/types";
import { getTool } from "./registry";
import { extractAndValidateParams } from "./param-extractor";
// De-shadowed (MONEY-620): the pure helpers live in executor-logic.ts so they
// can be unit-tested without importing the registry's react.cache chain.
import { sanitizeToolError, generateConfirmation } from "./executor-logic";

export interface ExecutionResult {
  executed: boolean;
  result?: ToolResult;
  needsConfirmation?: boolean;
  confirmationMessage?: string;
  error?: string;
}

/**
 * Execute a tool by name with given parameters
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  userId: string,
  skipConfirmation: boolean = false
): Promise<ExecutionResult> {
  const tool = getTool(toolName);
  if (!tool) {
    return {
      executed: false,
      error: "I couldn't process that action. Please try again.",
    };
  }

  // Validate parameters
  const validation = extractAndValidateParams(toolName, params);
  if (!validation.success) {
    return {
      executed: false,
      error: validation.clarifyingQuestion || "Invalid parameters",
    };
  }

  // Check confirmation requirement for write operations
  if (tool.requiresConfirmation && !skipConfirmation) {
    return {
      executed: false,
      needsConfirmation: true,
      confirmationMessage: generateConfirmation(toolName, validation.params!),
    };
  }

  // Execute the tool
  try {
    const result = await tool.execute(validation.params!, userId);
    return { executed: true, result };
  } catch (error) {
    return {
      executed: false,
      error: sanitizeToolError(error),
    };
  }
}

/**
 * Execute a confirmed tool (for write operations after user confirms)
 */
export async function executeConfirmedTool(
  toolName: string,
  params: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  const tool = getTool(toolName);
  if (!tool) {
    return {
      tool: toolName,
      success: false,
      error: "This action is not available. Please try again.",
    };
  }

  // Validate params before executing (prevent garbage data from reaching server actions)
  const validation = extractAndValidateParams(toolName, params);
  if (!validation.success) {
    return {
      tool: toolName,
      success: false,
      error:
        validation.clarifyingQuestion || "Invalid parameters for this action",
    };
  }

  try {
    return await tool.execute(validation.params!, userId);
  } catch (error) {
    return {
      tool: toolName,
      success: false,
      error: sanitizeToolError(error),
    };
  }
}
