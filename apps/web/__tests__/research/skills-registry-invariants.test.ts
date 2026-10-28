/**
 * Research skills registry — INVARIANT tests (registry-wide).
 *
 * Per-skill suites (skills-new.test.ts, skill-*.test.ts) assert individual
 * plan shapes; nothing asserted the REGISTRY-level invariants that the
 * matching machinery depends on. The dcf-valuation v1→v2 promotion showed
 * the hazard: a same-named skill left registered would silently shadow in
 * SKILL_MAP (last-wins) while matchSkill iterates the ARRAY — getSkill and
 * matchSkill could then disagree about which skill a name means.
 *
 * Pins, for every registered skill:
 *   - names are unique (and kebab-case), so SKILL_MAP ≡ ALL_SKILLS;
 *   - getSkill(name) returns the SAME object the array holds;
 *   - no two skills declare an IDENTICAL trigger regex (guaranteed shadow);
 *   - well-formed: description, ≥1 trigger, requiredParams declared;
 *   - FUNCTIONAL: buildPlan(defaults for its requiredParams) returns a
 *     plan satisfying the structural invariants (unique task ids, deps
 *     resolve, pending statuses, estimatedSteps == tasks, synthesis last).
 *
 * Source: packages/research/src/skills/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getAllSkills, getSkill, matchSkill } from "@usemoney/research/skills";
import type { ResearchPlan } from "@usemoney/research/types";

const SKILLS = getAllSkills();

/** Defaults covering every requiredParams name used by the registry. */
const PARAM_DEFAULTS: Record<string, unknown> = {
  symbol: "TCS",
  symbols: ["TCS", "INFY"],
  sector: "IT",
  query: "analyze TCS fundamentals",
  holdings: [
    { symbol: "TCS", quantity: 10, avgPrice: 3500 },
    { symbol: "INFY", quantity: 20, avgPrice: 1500 },
  ],
};

function paramsFor(skill: (typeof SKILLS)[number]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of skill.requiredParams) {
    assert.ok(
      p in PARAM_DEFAULTS,
      `unknown requiredParam "${p}" on ${skill.name} — extend PARAM_DEFAULTS`
    );
    params[p] = PARAM_DEFAULTS[p];
  }
  // Common optional context many builders read defensively.
  if (!("query" in params)) params.query = PARAM_DEFAULTS.query;
  return params;
}

function assertPlanInvariants(name: string, plan: ResearchPlan): void {
  assert.equal(
    plan.estimatedSteps,
    plan.tasks.length,
    `${name}: estimatedSteps`
  );
  assert.ok(plan.tasks.length > 0, `${name}: empty plan`);
  assert.ok(
    plan.tasks.every((t) => t.status === "pending"),
    `${name}: non-pending initial task`
  );
  const ids = plan.tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `${name}: duplicate task ids`);
  const idSet = new Set(ids);
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) {
      assert.ok(
        idSet.has(dep),
        `${name}: task ${t.id} depends on missing ${dep}`
      );
    }
    assert.ok(t.tool && t.tool.length > 0, `${name}: task ${t.id} has no tool`);
  }
  assert.equal(
    plan.tasks[plan.tasks.length - 1]!.type,
    "synthesis",
    `${name}: plan must end in synthesis`
  );
}

describe("skills registry — uniqueness", () => {
  it("registers a non-trivial number of skills", () => {
    assert.ok(SKILLS.length >= 30, `only ${SKILLS.length} skills registered`);
  });

  it("skill names are unique (SKILL_MAP cannot silently shadow)", () => {
    const names = SKILLS.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `duplicate skill names: ${dupes.join(", ")}`);
  });

  it("getSkill(name) returns the exact registered object for every skill", () => {
    for (const s of SKILLS) {
      assert.equal(getSkill(s.name), s, s.name);
    }
  });

  it("no two skills declare an identical (matchable) trigger regex", () => {
    const seen = new Map<string, string>();
    for (const s of SKILLS) {
      for (const t of s.triggers) {
        // Programmatically-routed skills (multi-comparison, mf-comparison)
        // share a deliberate never-matching sentinel — shadowing is
        // meaningless for a trigger that can't match.
        if (t.source.includes("__NEVER_MATCH__")) continue;
        const key = `${t.source}///${t.flags}`;
        const owner = seen.get(key);
        assert.ok(
          owner === undefined || owner === s.name,
          `trigger ${t} declared by both "${owner}" and "${s.name}" — the later one can never match`
        );
        seen.set(key, s.name);
      }
    }
  });
});

describe("skills registry — well-formedness", () => {
  for (const s of SKILLS) {
    it(`${s.name} is well-formed`, () => {
      assert.match(s.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case name");
      assert.ok(s.description.length >= 10, "description");
      assert.ok(s.triggers.length >= 1, "at least one trigger");
      assert.ok(Array.isArray(s.requiredParams), "requiredParams array");
      assert.equal(typeof s.buildPlan, "function");
    });
  }
});

describe("skills registry — every buildPlan is functional", () => {
  for (const s of SKILLS) {
    it(`${s.name}.buildPlan(defaults) yields a structurally valid plan`, () => {
      const plan = s.buildPlan(paramsFor(s));
      assertPlanInvariants(s.name, plan);
    });
  }
});

describe("skills registry — matching sanity", () => {
  // NB: "analyze TCS" (American spelling) matches NOTHING — the v1 trigger
  // /\b(analyz|analyse|…)\b/ can't put a word boundary between "analyz" and
  // "e". Known quirk, flagged separately; use a deterministic query here.
  it("matchSkill resolves a research query to a registered skill", () => {
    const m = matchSkill("research TCS");
    assert.ok(m, "no skill matched a plain research query");
    assert.equal(getSkill(m.name), m);
  });

  it("matchSkill resolves a buy-decision query", () => {
    const m = matchSkill("should I buy TCS?");
    assert.ok(m);
    assert.equal(getSkill(m.name), m);
  });
});
