/**
 * L2 narrative gate removal tests (MONEY-295 Bug 5) - REAL source.
 *
 * Exercises the ACTUAL helpers the chat fast-path branch calls (from
 * `@/app/api/chat/route-logic`): `shouldRunToolNarrative`,
 * `buildToolNarrativeFallbackBlocks`, and `TOOL_NARRATIVE_FALLBACK_TEXT`.
 *
 * The L2 narrative is just Flash summarizing already-fetched tool data — cost
 * ≈ l1_flash (0 credits). The legacy `consumeAIQuery` gate (which hard-blocked
 * FREE users) has been removed; the narrative now runs whenever Gemini is
 * enabled, regardless of plan. When Gemini is disabled the route falls back to
 * the generic "Here are your results." stub.
 *
 * (Replaces the previous SHADOW version, which reimplemented the decision
 * inline. `shouldRunToolNarrative` takes ONLY `geminiEnabled` — so the legacy
 * quota CANNOT re-enter the decision by construction, which is the invariant
 * the fix guarantees.)
 *
 * Source: apps/web/app/api/chat/route.ts (the fast-path tool narrative branch)
 *         apps/web/app/api/chat/route-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TextBlock } from "@usemoney/types";

import {
  shouldRunToolNarrative,
  buildToolNarrativeFallbackBlocks,
  TOOL_NARRATIVE_FALLBACK_TEXT,
} from "@/app/api/chat/route-logic";

interface RouteDecision {
  /** Whether the narrative pipeline (Flash summary + auto-format blocks) runs. */
  runsNarrative: boolean;
  /** Whether the "Here are your results." stub fallback fires. */
  firesFallbackStub: boolean;
}

/**
 * Models the route's fast-path branch using the REAL gate. The outer
 * `toolExecuted && toolSuccess` precondition is the route's
 * `if (toolResult.executed && toolResult.result?.success)` guard; inside it,
 * `shouldRunToolNarrative(geminiEnabled)` decides narrative-vs-stub.
 * `legacyQuotaSucceeded` is intentionally unused — the gate is gone.
 */
function decide(inputs: {
  geminiEnabled: boolean;
  toolExecuted: boolean;
  toolSuccess: boolean;
  legacyQuotaSucceeded: boolean;
}): RouteDecision {
  if (!inputs.toolExecuted || !inputs.toolSuccess) {
    return { runsNarrative: false, firesFallbackStub: false };
  }
  if (shouldRunToolNarrative(inputs.geminiEnabled)) {
    return { runsNarrative: true, firesFallbackStub: false };
  }
  return { runsNarrative: false, firesFallbackStub: true };
}

describe("Chat fast-path narrative gate (FREE plan unblock)", () => {
  it("FREE user (legacy quota would fail) - narrative still runs", () => {
    const decision = decide({
      geminiEnabled: true,
      toolExecuted: true,
      toolSuccess: true,
      legacyQuotaSucceeded: false, // FREE blocked at sub.service:639
    });
    assert.equal(decision.runsNarrative, true);
    assert.equal(decision.firesFallbackStub, false);
  });

  it("PRO user (legacy quota succeeds) - narrative runs (unchanged)", () => {
    const decision = decide({
      geminiEnabled: true,
      toolExecuted: true,
      toolSuccess: true,
      legacyQuotaSucceeded: true,
    });
    assert.equal(decision.runsNarrative, true);
  });

  it("Gemini disabled - falls through to stub fallback", () => {
    const decision = decide({
      geminiEnabled: false,
      toolExecuted: true,
      toolSuccess: true,
      legacyQuotaSucceeded: true,
    });
    assert.equal(decision.runsNarrative, false);
    assert.equal(decision.firesFallbackStub, true);
  });

  it("legacyQuotaSucceeded value does not affect outcome (gate removed)", () => {
    const a = decide({
      geminiEnabled: true,
      toolExecuted: true,
      toolSuccess: true,
      legacyQuotaSucceeded: true,
    });
    const b = decide({
      geminiEnabled: true,
      toolExecuted: true,
      toolSuccess: true,
      legacyQuotaSucceeded: false,
    });
    assert.deepEqual(a, b);
  });

  it("shouldRunToolNarrative is a pure function of geminiEnabled only", () => {
    assert.equal(shouldRunToolNarrative(true), true);
    assert.equal(shouldRunToolNarrative(false), false);
  });
});

describe("Tool-narrative fallback stub (Gemini disabled)", () => {
  it("returns a single text block with the fallback copy", () => {
    const blocks = buildToolNarrativeFallbackBlocks();
    assert.equal(blocks.length, 1);
    const textBlock = blocks[0] as TextBlock;
    assert.equal(textBlock.type, "text");
    assert.equal(textBlock.content, TOOL_NARRATIVE_FALLBACK_TEXT);
  });

  it("fallback text is the stable 'Here are your results.' copy", () => {
    assert.equal(TOOL_NARRATIVE_FALLBACK_TEXT, "Here are your results.");
  });
});
