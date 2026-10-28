/**
 * MONEY-1120 — v1 skill aliases must be expanded BEFORE the planner prompt.
 *
 * Reported in the MONEY-1095 bug doc as items 5, 7 and 11: /peer returned a
 * generic "what would you like to know" card, /earnings failed outright, and
 * /dcf produced a generic partial report.
 *
 * Root cause: `buildAllowedToolSet` (the post-plan trim) expanded v1 aliases
 * internally, but the RAW ids were handed to `buildPlannerUserPrompt`. That
 * prompt embeds a "skill → tool" mapping table containing v2 ids only, then
 * instructs the model to "emit the matching compute task(s)" for EACH selected
 * skill using ONLY listed tools. A v1 alias therefore had no row to match, so
 * the planner fell back to a generic plan — which the trim then cut down to
 * the alias's real tools. The two halves disagreed about what the run was for.
 *
 * The asymmetry is the whole bug, so these tests assert the two halves agree.
 *
 * Source: packages/research/src/skills/skill-tool-map.ts (expandSkillAliases)
 *         packages/research/src/prompts.ts (buildPlannerUserPrompt)
 *         packages/research/src/agent.ts (expansion call site)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expandSkillAliases,
  SKILL_TOOL_ALLOWLIST,
} from "../src/skills/skill-tool-map";
import { buildPlannerUserPrompt } from "../src/prompts";

/**
 * The v1 aliases, pinned. Each is a skill id a caller may legitimately send
 * (the slash-command registry sends four of these) that is NOT a planner-
 * mappable v2 id on its own.
 */
const V1_ALIASES = [
  "investment-thesis",
  "peer-comparison",
  "earnings-analysis",
  "financial-deep-dive",
  "stock-analysis",
  "macro-analysis",
] as const;

/** Skill ids the slash-command shortcuts actually send (apps/web registry). */
const SLASH_COMMAND_PRESET_SKILLS = [
  "peer-comparison", // /peer
  "dcf-valuation", // /dcf
  "investment-thesis", // /thesis
  "earnings-analysis", // /earnings
  "stock-analysis", // /technical
] as const;

/** Does the planner prompt contain a "skill → tools" row for this id? */
function plannerCanMap(skillId: string): boolean {
  const prompt = buildPlannerUserPrompt("Analyze TCS", undefined, [skillId]);
  // The mapping table renders as `\n  <skill-id>  → tool, tool`.
  return new RegExp(`\\n\\s+${skillId}\\s+→`).test(prompt);
}

describe("MONEY-1120 — expandSkillAliases", () => {
  it("expands every v1 alias to at least one v2 skill", () => {
    for (const alias of V1_ALIASES) {
      const expanded = expandSkillAliases([alias]);
      assert.ok(
        expanded.length > 0,
        `${alias} must expand to at least one v2 skill`,
      );
      assert.ok(
        !expanded.includes(alias as never),
        `${alias} must not expand to itself`,
      );
    }
  });

  it("every expanded id exists in the tool allow-list", () => {
    for (const alias of V1_ALIASES) {
      for (const id of expandSkillAliases([alias])) {
        assert.ok(
          SKILL_TOOL_ALLOWLIST[id],
          `${alias} expanded to '${id}', which has no tool allow-list entry`,
        );
      }
    }
  });

  it("is idempotent — a v2 id passes through untouched", () => {
    // The agent expands unconditionally, so this property is what makes it
    // safe to call on input that may already be expanded.
    const once = expandSkillAliases(["dcf-valuation"]);
    assert.deepEqual(once, ["dcf-valuation"]);
    assert.deepEqual(expandSkillAliases(once), once);
  });

  it("drops ids that are neither an alias nor a known skill", () => {
    assert.deepEqual(expandSkillAliases(["not-a-real-skill"]), []);
  });

  it("de-duplicates when two aliases share a constituent", () => {
    // investment-thesis and peer-comparison both include relative-valuation.
    const expanded = expandSkillAliases([
      "investment-thesis",
      "peer-comparison",
    ]);
    assert.equal(
      new Set(expanded).size,
      expanded.length,
      "expansion must not emit duplicates",
    );
  });
});

describe("MONEY-1120 — MINIMUM TASK COUNT is derived from the selection", () => {
  /** The floor the planner prompt asks the model for. */
  function minTasks(skills: readonly string[]): number {
    const prompt = buildPlannerUserPrompt("Analyze TCS", undefined, skills);
    const m = prompt.match(/MINIMUM TASK COUNT: (\d+)/);
    assert.ok(m, "prompt must state a MINIMUM TASK COUNT");
    return Number(m[1]);
  }

  it("a single focused skill no longer inherits the old floor of 8", () => {
    // Was `8 + customSkills.length * 2` — one skill still demanded >= 10 tasks,
    // which is what pushed /dcf into a 14-task plan that overran the budget.
    const dcf = minTasks(["dcf-valuation"]);
    assert.ok(
      dcf < 10,
      `one focused skill should plan fewer than the old floor of 10, got ${dcf}`,
    );
  });

  it("scales with the number of tools the selection actually needs", () => {
    const one = minTasks(["dcf-valuation"]);
    const many = minTasks([
      "fundamentals-core",
      "dcf-valuation",
      "relative-valuation",
    ]);
    assert.ok(
      many > one,
      `a 3-skill selection (${many}) must plan more than a 1-skill one (${one})`,
    );
  });

  it("never drops below a floor of 4 for a very small skill", () => {
    // global-funds has only 2 tools; a stub plan would be useless.
    assert.ok(minTasks(["global-funds"]) >= 4);
  });

  it("never exceeds the cap of 28", () => {
    const everySkill = Object.keys(SKILL_TOOL_ALLOWLIST);
    assert.ok(minTasks(everySkill) <= 28);
  });

  it("an alias is sized by what it expands to, not counted as one skill", () => {
    // investment-thesis → fundamentals-core + dcf-valuation + relative-valuation.
    // The old formula saw "1 skill" and asked for 10; it is genuinely bigger.
    assert.equal(
      minTasks(["investment-thesis"]),
      minTasks(["fundamentals-core", "dcf-valuation", "relative-valuation"]),
      "an alias must size identically to its expansion",
    );
  });
});

describe("MONEY-1120 — planner prompt can map what it is given", () => {
  it("reproduces the defect: a RAW v1 alias has no mapping row", () => {
    // This is what the planner used to receive. Documented as a test so the
    // reason expansion exists cannot be lost.
    assert.equal(
      plannerCanMap("peer-comparison"),
      false,
      "peer-comparison is a v1 alias — the prompt table has no row for it",
    );
  });

  it("every EXPANDED id has a mapping row the planner can use", () => {
    for (const alias of V1_ALIASES) {
      for (const id of expandSkillAliases([alias])) {
        assert.ok(
          plannerCanMap(id),
          `${alias} → '${id}' has no row in the planner prompt's skill→tool table`,
        );
      }
    }
  });

  it("every slash-command preset resolves to planner-mappable skills", () => {
    // The end-to-end invariant the bug violated: whatever /peer, /dcf,
    // /thesis, /earnings and /technical send must, after expansion, be
    // something the planner can actually turn into compute tasks.
    for (const preset of SLASH_COMMAND_PRESET_SKILLS) {
      const expanded = expandSkillAliases([preset]);
      assert.ok(expanded.length > 0, `${preset} expanded to nothing`);
      for (const id of expanded) {
        assert.ok(
          plannerCanMap(id),
          `slash-command preset '${preset}' → '${id}' is not planner-mappable`,
        );
      }
    }
  });
});
