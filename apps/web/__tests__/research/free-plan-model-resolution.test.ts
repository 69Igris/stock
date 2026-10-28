/**
 * Research model resolution by tier — MONEY-619.
 *
 * `research.ts` (+ `analysis.ts` / `comparison.ts`) resolve the research
 * model via the single-source-of-truth `resolveResearchModel(planId, pick)`.
 * The 3.x family is GA + available by default (no env gate), so:
 *   - FREE research stays on gemini-2.5-pro
 *   - PRO + PREMIUM default to the tier Pro model (gemini-3.1-pro-preview)
 *   - an explicit Pro-tier pick the plan allows is honored; FREE can't escalate
 *
 * Source: packages/core/src/gemini/model-registry.ts → resolveResearchModel
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveResearchModel } from "@usemoney/core/gemini/model-registry";

describe("resolveResearchModel — tier-aware research model (MONEY-619)", () => {
  it("FREE research stays on gemini-2.5-pro", () => {
    assert.equal(resolveResearchModel("FREE", null), "gemini-2.5-pro");
    assert.equal(
      resolveResearchModel("FREE", "gemini-2.5-flash"),
      "gemini-2.5-pro"
    );
  });

  it("PRO + PREMIUM default to the tier Pro model (gemini-3.1-pro-preview)", () => {
    assert.equal(resolveResearchModel("PRO", null), "gemini-3.1-pro-preview");
    assert.equal(
      resolveResearchModel("PREMIUM", null),
      "gemini-3.1-pro-preview"
    );
  });

  it("honors an explicit Pro-tier pick the plan allows", () => {
    assert.equal(
      resolveResearchModel("PRO", "gemini-2.5-pro"),
      "gemini-2.5-pro"
    );
  });

  it("FREE cannot escalate to a paid model", () => {
    assert.equal(
      resolveResearchModel("FREE", "gemini-3.1-pro-preview"),
      "gemini-2.5-pro"
    );
  });
});
