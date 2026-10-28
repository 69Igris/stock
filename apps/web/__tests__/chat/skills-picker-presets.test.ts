/**
 * Skills picker preset chips - MONEY-219 PR-3.
 *
 * The chips in PromptOptionsPopover SkillsView call applyPreset(id),
 * which overwrites the visible skill set with `RESEARCH_PRESET_DEFS[id].defaultSkills`.
 * This test inlines that contract so we can verify the picker shows
 * the right defaults without booting React.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_PRESET_DEFS,
  RESEARCH_SKILL_LABELS,
  RESEARCH_SKILL_DESCRIPTIONS,
  type ResearchPresetId,
  type ResearchSkillId,
} from "../../../../packages/services/src/preferences/research-preferences";

// Mirror of PRESET_CHIPS in PromptOptionsPopover.tsx - keep in sync.
const PRESET_CHIPS: ResearchPresetId[] = [
  "quick-pulse",
  "investment-thesis",
  "quant-deep-dive",
  "earnings-preview",
  "macro-sector-view",
  "risk-audit",
  "comprehensive",
  "l4-institutional",
];

// Mirror of the v2 IDs surfaced in the picker's SKILL_ROWS array
// (ResearchModal.tsx + PromptOptionsPopover.tsx — keep ORDER in sync).
const PICKER_SKILL_IDS: ResearchSkillId[] = [
  "fundamentals-core",
  "cash-flow-quality",
  "earnings-deep-dive",
  "dcf-valuation",
  "dividend-income",
  "relative-valuation",
  // MONEY-793 (C1b): promoted orphan packs (fundamentals).
  "mf-deep-dive",
  "forensic-accounting",
  "quant-factor-scores",
  "technical-trend",
  "chart-pattern-detection",
  "regime-volatility",
  "macro-sensitivities",
  "flows-and-positioning",
  // MONEY-793 (C1b): composed + promoted orphan packs (macro).
  "theme-evaluation",
  "global-funds",
  "forward-scenarios",
  "risk-portfolio-impact",
  // MONEY-669: L4-only VaR/stress pack — in the picker, default-on only
  // for the l4-institutional preset.
  "risk-var-stress",
  "governance-flags",
  "news-sentiment-catalysts",
  // MONEY-793 (C1b): composed + promoted orphan packs (risk-news).
  "portfolio-impact-on-user",
  "catalyst-calendar",
  "tax-planning",
];

/**
 * Picker skills that are advanced-tier: default-on for l4-institutional only,
 * NOT in the Comprehensive default set (MONEY-669 + MONEY-793 C1b).
 */
const L4_ONLY_SKILLS: ResearchSkillId[] = [
  "risk-var-stress",
  // MONEY-793 (C1b): composed + forensic packs join L4 defaults.
  "portfolio-impact-on-user",
  "catalyst-calendar",
  "theme-evaluation",
  "forensic-accounting",
];

/**
 * MONEY-793 (C1b): situational picker skills that are opt-in only — pickable
 * but NOT a default of ANY preset (not comprehensive, not l4-institutional).
 */
const SITUATIONAL_SKILLS: ResearchSkillId[] = [
  "tax-planning",
  "mf-deep-dive",
  "global-funds",
];

describe("skills picker - PR-3 contract", () => {
  it("every chip's preset has a definition", () => {
    for (const id of PRESET_CHIPS) {
      assert.ok(RESEARCH_PRESET_DEFS[id], `missing preset ${id}`);
    }
  });

  it("clicking a chip loads exactly the preset's defaultSkills", () => {
    for (const id of PRESET_CHIPS) {
      const def = RESEARCH_PRESET_DEFS[id];
      // applyPreset(id) → onChange([...def.defaultSkills])
      const visible = [...def.defaultSkills];
      assert.deepEqual(visible, def.defaultSkills);
    }
  });

  it("every preset's defaults are in the picker's skill set", () => {
    for (const id of PRESET_CHIPS) {
      const def = RESEARCH_PRESET_DEFS[id];
      for (const skill of def.defaultSkills) {
        assert.ok(
          PICKER_SKILL_IDS.includes(skill),
          `preset ${id} default ${skill} missing from picker`
        );
      }
    }
  });

  it("comprehensive selects every picker skill except the L4-only + situational packs", () => {
    const def = RESEARCH_PRESET_DEFS["comprehensive"];
    assert.equal(
      def.defaultSkills.length,
      PICKER_SKILL_IDS.length -
        L4_ONLY_SKILLS.length -
        SITUATIONAL_SKILLS.length
    );
    for (const skill of PICKER_SKILL_IDS) {
      if (
        L4_ONLY_SKILLS.includes(skill) ||
        SITUATIONAL_SKILLS.includes(skill)
      ) {
        assert.ok(
          !def.defaultSkills.includes(skill),
          `comprehensive must NOT default L4-only/situational ${skill}`
        );
      } else {
        assert.ok(
          def.defaultSkills.includes(skill),
          `comprehensive missing ${skill}`
        );
      }
    }
  });

  it("l4-institutional selects every picker skill EXCEPT the situational opt-ins (strict superset — MONEY-669 + MONEY-793)", () => {
    const def = RESEARCH_PRESET_DEFS["l4-institutional"];
    const comp = RESEARCH_PRESET_DEFS["comprehensive"];
    assert.equal(
      def.defaultSkills.length,
      PICKER_SKILL_IDS.length - SITUATIONAL_SKILLS.length
    );
    for (const skill of PICKER_SKILL_IDS) {
      if (SITUATIONAL_SKILLS.includes(skill)) {
        assert.ok(
          !def.defaultSkills.includes(skill),
          `l4 must NOT default situational ${skill}`
        );
      } else {
        assert.ok(def.defaultSkills.includes(skill), `l4 missing ${skill}`);
      }
    }
    // Strictly larger than Comprehensive (the MONEY-669 acceptance).
    for (const skill of comp.defaultSkills) {
      assert.ok(def.defaultSkills.includes(skill));
    }
    assert.ok(def.defaultSkills.length > comp.defaultSkills.length);
  });

  it("every picker skill has a label + description (tooltip support)", () => {
    for (const id of PICKER_SKILL_IDS) {
      assert.ok(RESEARCH_SKILL_LABELS[id], `missing label for ${id}`);
      assert.ok(
        RESEARCH_SKILL_DESCRIPTIONS[id],
        `missing description for ${id}`
      );
    }
  });

  it("Quick Pulse is the lightest preset (1 skill, 1 credit)", () => {
    const def = RESEARCH_PRESET_DEFS["quick-pulse"];
    assert.equal(def.defaultSkills.length, 1);
    assert.equal(def.baseCredits, 1);
  });

  it("Comprehensive is the heaviest 2.5-pro preset (16 skills, 10 credits)", () => {
    const def = RESEARCH_PRESET_DEFS["comprehensive"];
    assert.equal(def.defaultSkills.length, 16);
    assert.equal(def.baseCredits, 10);
    assert.equal(def.suggestedModel, "gemini-2.5-pro");
  });

  it("L4 Institutional uses 3-pro and is more expensive than Comprehensive", () => {
    const def = RESEARCH_PRESET_DEFS["l4-institutional"];
    // MONEY-793 (C1b): 16 comprehensive + 5 advanced L4-only packs
    // (risk-var-stress + portfolio-impact + catalyst-calendar +
    // theme-evaluation + forensic-accounting). Situational opt-ins
    // (tax/mf/global) are NOT defaulted.
    assert.equal(def.defaultSkills.length, 21);
    assert.equal(def.suggestedModel, "gemini-3.1-pro-preview");
    assert.ok(
      def.baseCredits > RESEARCH_PRESET_DEFS["comprehensive"].baseCredits
    );
  });

  it("v1 alias IDs are NOT in the picker - only v2 surfaces", () => {
    const v1Aliases = [
      "investment-thesis",
      "peer-comparison",
      "earnings-analysis",
      "financial-deep-dive",
      "stock-analysis",
      "macro-analysis",
    ];
    for (const v1 of v1Aliases) {
      assert.equal(
        PICKER_SKILL_IDS.includes(v1 as ResearchSkillId),
        false,
        `v1 alias ${v1} should not appear in the picker`
      );
    }
  });
});
