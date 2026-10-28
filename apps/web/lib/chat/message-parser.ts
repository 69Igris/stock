/**
 * Message Parser
 *
 * Parses raw AI text into ContentBlock[] by detecting :::block:TYPE markers.
 * Also handles legacy ACTION: markers for backward compatibility.
 */

import type { ContentBlock } from "@usemoney/types";
import { validateBlockData } from "@usemoney/validation";

/** Generate a UUID that works in both Node.js and browser */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Block marker regex: :::block:TYPE\n{JSON}\n:::
 */
const BLOCK_REGEX =
  /:::block:(table|card|chart|action|navigation|comparison|error|holdings|portfolio|tax|risk|mf|fire|sector|technical|news|scorecard|pnl|dividend|stock-list)\s*\n([\s\S]*?)\n:::/g;

/**
 * Legacy ACTION: marker regex
 */
const LEGACY_ACTION_REGEX = /ACTION:\s*(\w+)\s*\{([^}]+)\}/g;

/**
 * Parse a raw LLM response into ContentBlock[]
 */
export function parseMessageToBlocks(rawText: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let lastIndex = 0;

  // Reset regex state
  BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BLOCK_REGEX.exec(rawText)) !== null) {
    // Add text before this block
    const textBefore = rawText.slice(lastIndex, match.index).trim();
    if (textBefore) {
      blocks.push({ type: "text", content: textBefore });
    }

    const blockType = match[1] as string;
    const jsonStr = match[2].trim();

    try {
      const parsed = JSON.parse(jsonStr);
      const validation = validateBlockData(blockType, parsed);

      if (validation.success) {
        const blockData = validation.data as Record<string, unknown>;
        // For action blocks, always generate a valid actionId (LLM-fabricated ones
        // won't pass the confirm-UUID validation in /api/chat/execute-tool)
        if (blockType === "action") {
          blockData.actionId = `confirm-${generateUUID()}`;
        }
        blocks.push({
          type: blockType,
          ...blockData,
        } as ContentBlock);
      } else {
        // Invalid JSON structure - render as code block
        blocks.push({
          type: "text",
          content: `\`\`\`json\n${jsonStr}\n\`\`\`\n\n*Block validation error: ${validation.error}*`,
        });
      }
    } catch {
      // Invalid JSON - render as code block
      blocks.push({
        type: "text",
        content: `\`\`\`\n${jsonStr}\n\`\`\``,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last block
  const remainingText = rawText.slice(lastIndex).trim();
  if (remainingText) {
    // Check for legacy ACTION: markers and convert
    const cleanedText = convertLegacyActions(remainingText, blocks);
    if (cleanedText.trim()) {
      blocks.push({ type: "text", content: cleanedText.trim() });
    }
  }

  // If no blocks were found, treat entire response as text
  if (blocks.length === 0 && rawText.trim()) {
    const cleanedText = convertLegacyActions(rawText.trim(), blocks);
    if (cleanedText.trim()) {
      blocks.push({ type: "text", content: cleanedText.trim() });
    }
    // If only legacy actions were found and no text remains, ensure at least the blocks are returned
    if (blocks.length === 0 && rawText.trim()) {
      blocks.push({ type: "text", content: rawText.trim() });
    }
  }

  return blocks;
}

/**
 * Convert legacy ACTION: markers to ActionBlock and return cleaned text
 */
function convertLegacyActions(text: string, blocks: ContentBlock[]): string {
  LEGACY_ACTION_REGEX.lastIndex = 0;
  let cleaned = text;
  let match: RegExpExecArray | null;

  while ((match = LEGACY_ACTION_REGEX.exec(text)) !== null) {
    const actionType = match[1];
    const paramsStr = match[2];

    try {
      const params = parseLegacyParams(paramsStr);
      blocks.push({
        type: "action",
        actionId: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tool: actionType,
        description: generateLegacyDescription(actionType, params),
        params,
        status: "pending",
      });
    } catch {
      // Leave the text as-is if parsing fails
    }

    cleaned = cleaned.replace(match[0], "");
  }

  return cleaned;
}

/**
 * Parse legacy ACTION parameter string "key: value, key2: value2"
 */
function parseLegacyParams(paramsStr: string): Record<string, unknown> {
  const jsonStr = `{${paramsStr}}`
    .replace(/(\w+):/g, '"$1":')
    .replace(/:\s*"([^"]*)"/g, ': "$1"')
    .replace(/:\s*([^",}\]]+)/g, (_match, value) => {
      const trimmed = value.trim();
      if (
        trimmed === "true" ||
        trimmed === "false" ||
        !isNaN(Number(trimmed))
      ) {
        return `: ${trimmed}`;
      }
      return `: "${trimmed}"`;
    });

  return JSON.parse(jsonStr);
}

/**
 * Generate a human-readable description for a legacy action
 */
function generateLegacyDescription(
  actionType: string,
  params: Record<string, unknown>
): string {
  switch (actionType) {
    case "create_scenario":
      return `Create FIRE scenario "${params.name}"`;
    case "modify_scenario":
      return `Modify FIRE scenario "${params.name}"`;
    case "delete_scenario":
      return `Delete FIRE scenario "${params.name}"`;
    case "add_stock":
      return `Add ${params.quantity} shares of ${params.symbol} at ₹${params.buyPrice}`;
    case "add_mutual_fund":
      return `Add ${params.units} units of ${params.schemeName}`;
    case "remove_holding":
      return `Remove ${params.symbol} from holdings`;
    case "save_analysis":
      // MONEY-457: dropped the `${params.recommendation}` interpolation —
      // labelled BUY/HOLD/SELL verdicts are forbidden per SEBI RA
      // Regulations and the validator now requires recommendation="N/A".
      return `Save analysis for ${params.symbol}`;
    default:
      return "Confirm this action";
  }
}

/**
 * Check if a response contains any block markers
 */
export function hasBlockMarkers(text: string): boolean {
  // BLOCK_REGEX / LEGACY_ACTION_REGEX are module-level GLOBAL (/g) regexes, so
  // `.test()` advances their `lastIndex` and leaves it non-zero. Without
  // resetting, a second call with the same input resumes past the previous
  // match and wrongly returns false (a true/false/true flip-flop). Reset both
  // before testing so the result depends only on `text`, never on call order.
  BLOCK_REGEX.lastIndex = 0;
  LEGACY_ACTION_REGEX.lastIndex = 0;
  return BLOCK_REGEX.test(text) || LEGACY_ACTION_REGEX.test(text);
}

/**
 * Strip all block markers from text (for plain-text fallback)
 */
export function stripBlockMarkers(text: string): string {
  return text.replace(BLOCK_REGEX, "").replace(LEGACY_ACTION_REGEX, "").trim();
}
