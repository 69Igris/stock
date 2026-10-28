/**
 * Layer 1: Input Validation - pure logic
 *
 * The context-permission helpers live here, decoupled from the tool registry
 * (which pulls server actions → `react.cache` and cannot load under node:test).
 * `input-validator.ts` resolves the tool via `getTool` and then calls
 * `isToolAllowedInContext`, so production and the unit tests run the SAME
 * permission logic (no shadow).
 */

import type { ChatContextModeSerializable } from "@usemoney/types";

/** Minimal shape of a tool needed for the context-permission check. */
export interface ToolContextScope {
  contexts: string[];
}

/**
 * Normalise a serialized chat context mode into the context key used for tool
 * permission checks. Broker-specific contexts still allow every tool, so they
 * collapse to "all".
 */
export function parseContextKey(context: ChatContextModeSerializable): string {
  if (context === "all") return "all";
  if (context.startsWith("broker:")) return "all"; // Broker-specific still allows all tools
  return context;
}

/**
 * Decide whether a tool is permitted in the given context key.
 *
 * - A missing/unknown tool is never allowed.
 * - The "all" context allows everything.
 * - Otherwise the tool must list the context in its `contexts`.
 */
export function isToolAllowedInContext(
  tool: ToolContextScope | null | undefined,
  contextKey: string
): boolean {
  if (!tool) return false;
  if (contextKey === "all") return true;
  return tool.contexts.includes(contextKey);
}
