/**
 * Skills picker - v1 alias normalization on read + write.
 *
 * Bug from QA: a user with saved customSkills = ["investment-thesis",
 * "macro-analysis"] (legacy v1 IDs) saw "Selected: 6 / 16 skills" in
 * the picker but every checkbox was empty. Root cause: the picker's
 * `value.includes(row.id)` check compared against v2 row IDs while
 * the saved value still held v1 IDs.
 *
 * Fix in PromptOptionsPopover.tsx:
 *   - Read path: `skills = expandSkillAliases(prefs.customSkills)`
 *     so v1 IDs render as their v2 equivalents.
 *   - Write path: `save({ customSkills: expandSkillAliases(next) })`
 *     so the on-disk value converges to v2-only over time.
 *
 * This test inlines the contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandSkillAliases } from "../../../../packages/services/src/preferences/research-preferences";

describe("skills picker - alias normalization", () => {
  it("legacy investment-thesis renders as 3 v2 chips checked", () => {
    const stored = ["investment-thesis"];
    const visible = expandSkillAliases(stored as never);
    assert.deepEqual(visible.sort(), [
      "dcf-valuation",
      "fundamentals-core",
      "relative-valuation",
    ]);
  });

  it("legacy macro-analysis renders as 2 v2 chips checked", () => {
    const visible = expandSkillAliases(["macro-analysis"] as never);
    assert.deepEqual(visible.sort(), [
      "flows-and-positioning",
      "macro-sensitivities",
    ]);
  });

  it("the QA-reported case: investment-thesis + macro-analysis = 5 unique v2 IDs", () => {
    // The user saw "6 selected" - that came from the raw count of
    // expanded IDs (3 + 2 = 5 if no dedupe, but actually 5 with dedupe).
    // The bug was that NONE of those 5 rendered as checkboxes - fixed
    // by passing the expanded set to SkillsView.
    const stored = ["investment-thesis", "macro-analysis"];
    const visible = expandSkillAliases(stored as never);
    assert.equal(visible.length, 5);
    assert.ok(visible.includes("fundamentals-core"));
    assert.ok(visible.includes("dcf-valuation"));
    assert.ok(visible.includes("relative-valuation"));
    assert.ok(visible.includes("macro-sensitivities"));
    assert.ok(visible.includes("flows-and-positioning"));
  });

  it("legacy stock-analysis (technical umbrella) expands to 3 v2 IDs", () => {
    const visible = expandSkillAliases(["stock-analysis"] as never);
    assert.deepEqual(visible.sort(), [
      "chart-pattern-detection",
      "fundamentals-core",
      "technical-trend",
    ]);
  });

  it("v2 IDs pass through unchanged", () => {
    const v2 = [
      "fundamentals-core",
      "quant-factor-scores",
      "regime-volatility",
    ];
    const out = expandSkillAliases(v2 as never);
    assert.deepEqual(out.sort(), [...v2].sort());
  });

  it("write path: passing v1 to handleSkillsChange writes v2 only (eventual migration)", () => {
    // Mirrors the new save handler:
    //   save({ customSkills: expandSkillAliases(next) })
    const userPicked = ["peer-comparison", "earnings-analysis"];
    const persisted = expandSkillAliases(userPicked as never);
    // peer-comparison → relative-valuation
    // earnings-analysis → earnings-deep-dive
    assert.deepEqual(persisted.sort(), [
      "earnings-deep-dive",
      "relative-valuation",
    ]);
    // After this write the user's stored value is v2 - the next read
    // doesn't need to expand anything.
    const reread = expandSkillAliases(persisted);
    assert.deepEqual(reread.sort(), persisted.sort());
  });
});
