/**
 * Expert Persona Registry
 *
 * 10 domain-specific expert personas that are dynamically selected based on the
 * user's query. The persona DATA (registry, types, shared prompt blocks, pure
 * helpers) lives in `./prompt-personas-data` so it can be imported without the
 * server-only `@/lib/chat-tools` chain (MONEY-620). This module re-exports that
 * surface unchanged and adds `composeSystemPrompt`, the only piece that needs
 * the live tool descriptions.
 *
 * TODO: SEBI-compliance review — flag at prompt-personas-data.ts (persona
 *   titles + IDs). Several persona TITLES read as SEBI-regulated roles
 *   ("Senior Equity Research Analyst", "Wealth Advisor", "Private Banker",
 *   "Sell-Side Analyst"). The `systemPromptInstructions` are already SEBI-aware
 *   (observation-only, no buy/sell/hold verdicts) but the chat UI surfaces the
 *   raw `title`. A neutral rename needs a coordinated update across the
 *   intent-mapper / chat-router that reference the persona IDs.
 */

import { getToolDescriptions } from "@/lib/chat-tools";
import type { ChatContextModeSerializable } from "@usemoney/types";
import {
  BASE_HEDGE_FUND_PREAMBLE,
  TOOL_CALL_INSTRUCTIONS,
  BLOCK_FORMAT_INSTRUCTIONS,
  SHARED_COMPLIANCE_BLOCK,
  getContextDescription,
  type ExpertPersona,
} from "./prompt-personas-data";

// Re-export the full persona DATA surface so existing imports of
// `@/lib/gemini/prompt-personas` keep working unchanged.
export {
  PERSONAS,
  getPersona,
  getAllPersonaIds,
  getContextDescription,
  BASE_HEDGE_FUND_PREAMBLE,
  SHARED_COMPLIANCE_BLOCK,
  BLOCK_FORMAT_INSTRUCTIONS,
  TOOL_CALL_INSTRUCTIONS,
} from "./prompt-personas-data";
export type { ChipDef, ExpertPersona, PersonaId } from "./prompt-personas-data";

// ============== Prompt Composer ==============

/**
 * Compose the full system prompt for a given persona.
 */
export function composeSystemPrompt(
  persona: ExpertPersona,
  options: {
    context?: ChatContextModeSerializable;
    userName?: string;
    userContext?: string;
    tier?: string;
  }
): string {
  const { context = "all", userName, userContext, tier } = options;

  // Determine tool context for filtering available tools
  const contextKey =
    context === "all"
      ? "all"
      : typeof context === "string" && context.startsWith("broker:")
        ? "all"
        : context;

  // Get tool descriptions - filtered to persona's applicable tools if specified
  const toolDescriptions = getToolDescriptions(contextKey);

  const contextDescription = getContextDescription(context);

  const userContextBlock = userContext
    ? `\nPAGE-SPECIFIC DATA (use this to answer questions - do NOT fetch again):\n${userContext}\n`
    : "";

  const tierContext = tier
    ? `\nANALYSIS DEPTH: ${tier === "L3" ? "Comprehensive (institutional-grade depth)" : tier === "L2" ? "Research-grade analysis" : "Quick lookup / definition"}\n`
    : "";

  return `${BASE_HEDGE_FUND_PREAMBLE}

EXPERT PERSONA: ${persona.title}
${persona.systemPromptInstructions}

${contextDescription}
${userContextBlock}${tierContext}
${userName ? `The user's name is ${userName}.` : ""}

AVAILABLE TOOLS:
${toolDescriptions}

${TOOL_CALL_INSTRUCTIONS}

${BLOCK_FORMAT_INSTRUCTIONS}

${SHARED_COMPLIANCE_BLOCK}`;
}
