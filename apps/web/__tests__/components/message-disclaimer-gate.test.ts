/**
 * Chat advisory-disclaimer gate — MONEY-501 (SEBI IA Reg 18(9))
 *
 * De-shadowed: imports the REAL messageIsAdvisory + NON_ADVISORY_BLOCK_TYPES
 * from components/chat/message-advisory-gate.ts, which MessageRenderer uses to
 * decide whether to render the SEBI AI-advisory footer. The footer must render
 * on EVERY advisory assistant message and must NOT render on pure error /
 * refusal / navigation / action turns.
 *
 * Source: apps/web/components/chat/MessageRenderer.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@usemoney/types";
import {
  messageIsAdvisory,
  NON_ADVISORY_BLOCK_TYPES,
} from "../../components/chat/message-advisory-gate";

// messageIsAdvisory only reads `.type`; build minimal blocks discriminated by it.
function block(type: ContentBlock["type"]): ContentBlock {
  return { type } as ContentBlock;
}
function msg(...types: ContentBlock["type"][]): ContentBlock[] {
  return types.map(block);
}

describe("messageIsAdvisory (MONEY-501 SEBI disclaimer gate)", () => {
  it("shows the disclaimer for advisory content blocks", () => {
    assert.equal(messageIsAdvisory(msg("text")), true);
    assert.equal(messageIsAdvisory(msg("card")), true);
    assert.equal(messageIsAdvisory(msg("table")), true);
    assert.equal(messageIsAdvisory(msg("stock-list")), true);
    assert.equal(messageIsAdvisory(msg("research-stream")), true);
  });

  it("does NOT show on pure error/refusal/navigation/action turns", () => {
    assert.equal(messageIsAdvisory(msg("error")), false);
    assert.equal(messageIsAdvisory(msg("refusal")), false);
    assert.equal(messageIsAdvisory(msg("navigation")), false);
    assert.equal(messageIsAdvisory(msg("action")), false);
  });

  it("shows when advisory content is mixed with an action/navigation block", () => {
    assert.equal(messageIsAdvisory(msg("action", "text")), true);
    assert.equal(messageIsAdvisory(msg("navigation", "card")), true);
  });

  it("INVARIANT: any non-exempt block triggers the disclaimer", () => {
    assert.equal(messageIsAdvisory(msg("roast-summary")), true);
    assert.equal(messageIsAdvisory(msg("comparison")), true);
    assert.equal(messageIsAdvisory(msg("chart")), true);
  });

  it("empty message is NOT advisory (no blocks → no footer)", () => {
    assert.equal(messageIsAdvisory([]), false);
  });

  it("exempt set is exactly the four self-documenting turn types", () => {
    assert.deepEqual([...NON_ADVISORY_BLOCK_TYPES].sort(), [
      "action",
      "error",
      "navigation",
      "refusal",
    ]);
  });
});
