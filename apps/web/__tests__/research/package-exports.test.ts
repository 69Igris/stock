/**
 * MONEY-393 §23 - @usemoney/research package public-surface guard.
 *
 * packages/research has 142 source files + zero local tests, but is
 * already covered cross-workspace via apps/web/__tests__/research/
 * (26 test files exercising the agent / planner / executor / skills /
 * tools). This file pins the public export surface so a refactor
 * can't silently drop a barrel export that downstream consumers rely
 * on (apps/web action layer + workers).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ResearchAgent,
  ResearchPlanner,
  ResearchExecutor,
  Scratchpad,
  ResearchValidator,
  LoopController,
  applyResearchPreferences,
  SKILL_TOOL_ALLOWLIST,
  ALWAYS_KEEP_TOOLS,
  buildAllowedToolSet,
  ResearchToolRegistry,
  getSkill,
  getAllSkills,
  matchSkill,
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies,
  getStrategyCategories,
  executeStrategy,
} from "@usemoney/research";

describe("MONEY-393 §23 - @usemoney/research barrel surface", () => {
  it("[core] ResearchAgent + Planner + Executor + Scratchpad + Validator + LoopController are exported", () => {
    for (const [name, fn] of [
      ["ResearchAgent", ResearchAgent],
      ["ResearchPlanner", ResearchPlanner],
      ["ResearchExecutor", ResearchExecutor],
      ["Scratchpad", Scratchpad],
      ["ResearchValidator", ResearchValidator],
      ["LoopController", LoopController],
    ] as const) {
      assert.equal(
        typeof fn,
        "function",
        `${name} must be exported as a class/function`
      );
    }
  });

  it("[preferences] applyResearchPreferences hook is exported", () => {
    assert.equal(typeof applyResearchPreferences, "function");
  });

  it("[skills] tool-allow-list + always-keep + builder are exported", () => {
    assert.equal(typeof SKILL_TOOL_ALLOWLIST, "object");
    assert.equal(typeof ALWAYS_KEEP_TOOLS, "object");
    assert.equal(typeof buildAllowedToolSet, "function");
    // SKILL_TOOL_ALLOWLIST is a record keyed by ResearchSkillId. Must
    // include at least the core skills so the runtime planner can map
    // a skill → its allowed tools.
    const keys = Object.keys(SKILL_TOOL_ALLOWLIST);
    assert.ok(
      keys.length >= 5,
      `SKILL_TOOL_ALLOWLIST must list ≥5 skills, found ${keys.length}: ${keys.join(", ")}`
    );
  });

  it("[skills] getSkill / getAllSkills / matchSkill are exported", () => {
    assert.equal(typeof getSkill, "function");
    assert.equal(typeof getAllSkills, "function");
    assert.equal(typeof matchSkill, "function");
    // Smoke check the registry - non-empty list of skills.
    const skills = getAllSkills();
    assert.ok(
      Array.isArray(skills) && skills.length > 0,
      "getAllSkills() must return a non-empty array"
    );
  });

  it("[tools] ResearchToolRegistry is exported as a class/function", () => {
    assert.equal(typeof ResearchToolRegistry, "function");
  });

  it("[strategies] BUILTIN_STRATEGIES + 4 query helpers + executor exported", () => {
    assert.ok(Array.isArray(BUILTIN_STRATEGIES));
    assert.equal(typeof getStrategyById, "function");
    assert.equal(typeof getStrategiesByCategory, "function");
    assert.equal(typeof searchStrategies, "function");
    assert.equal(typeof getStrategyCategories, "function");
    assert.equal(typeof executeStrategy, "function");
  });

  it("[strategies] BUILTIN_STRATEGIES contains the documented ~60+ entries", () => {
    // The package CLAUDE.md / TEST-COVERAGE.md document 60+ strategies.
    // Catches a refactor that accidentally drops half the list.
    assert.ok(
      BUILTIN_STRATEGIES.length >= 30,
      `BUILTIN_STRATEGIES has only ${BUILTIN_STRATEGIES.length} entries (expected ≥30)`
    );
  });

  it("[strategies] every built-in strategy has the required shape (id + name + category)", () => {
    for (const s of BUILTIN_STRATEGIES) {
      assert.ok(
        s.id && typeof s.id === "string",
        "strategy id must be non-empty string"
      );
      assert.ok(
        s.name && typeof s.name === "string",
        "strategy name must be non-empty string"
      );
      // category may be a string or an enum - just ensure it exists.
      assert.ok("category" in s, `strategy ${s.id} missing 'category' field`);
    }
  });

  it("[skills] getSkill returns null for an unknown id (no throw)", () => {
    const r = getSkill("definitely-not-a-real-skill" as never);
    assert.ok(
      r === null || r === undefined,
      "getSkill must safe-return on unknown id"
    );
  });

  it("[strategies] getStrategyById returns null for a missing id", () => {
    const r = getStrategyById("definitely-not-a-strategy");
    assert.ok(
      r === null || r === undefined,
      "getStrategyById must safe-return on missing id"
    );
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * MONEY-669 / MONEY-650 — skill-tool allowlist ↔ tool registry integrity.
 *
 * The MONEY-650 failure class: an allowlist entry references a tool name the
 * registry never registers, so the plan trim keeps (or the planner emits) a
 * tool the executor can only answer with "Unknown tool" — i.e. the tool is
 * silently dropped from results. Guard EVERY allowlist entry against it.
 *
 * Instantiating ResearchToolRegistry here is side-effect free at runtime:
 * the barrel import at the top of this file already loaded every tool
 * module, and the constructor only Map.set()s the imported tool defs — no
 * tool's execute() runs.
 * ────────────────────────────────────────────────────────────────────────── */

describe("MONEY-669/650 - SKILL_TOOL_ALLOWLIST ↔ ResearchToolRegistry integrity", () => {
  const registeredTools = new Set(new ResearchToolRegistry().getToolNames());

  // `compute_beta` was caught unregistered by this guard when the
  // risk-var-stress pack landed (MONEY-650 dropped-tools class) and is now
  // registered in registry.ts — the guard below covers ALL allowlisted
  // tools with no exceptions.
  const KNOWN_UNREGISTERED: ReadonlySet<string> = new Set([]);

  it("[skills] MONEY-669: 'risk-var-stress' pins the exact L4 VaR/stress tool pack", () => {
    const entry = SKILL_TOOL_ALLOWLIST["risk-var-stress"];
    assert.ok(
      Array.isArray(entry),
      "SKILL_TOOL_ALLOWLIST must have a 'risk-var-stress' key"
    );
    assert.deepEqual(
      [...entry],
      [
        "compute_var",
        "compute_drawdown",
        "compute_beta",
        "compute_risk_adjusted_returns",
        "compute_correlation_matrix",
      ],
      "risk-var-stress must list exactly the 5 registry risk tools (order included)"
    );
  });

  it("[tools] MONEY-650 guard: every tool in every allowlist entry resolves to a registered tool", () => {
    const offenders: string[] = [];
    for (const [skill, tools] of Object.entries(SKILL_TOOL_ALLOWLIST)) {
      for (const tool of tools) {
        if (KNOWN_UNREGISTERED.has(tool)) continue;
        if (!registeredTools.has(tool)) offenders.push(`${skill} → ${tool}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `allowlisted tools missing from ResearchToolRegistry (MONEY-650 dropped-tools class): ${offenders.join(", ")}`
    );
  });

  it("[tools] every ALWAYS_KEEP_TOOLS entry resolves to a registered tool", () => {
    for (const tool of ALWAYS_KEEP_TOOLS) {
      assert.ok(
        registeredTools.has(tool),
        `ALWAYS_KEEP tool '${tool}' must be registered in ResearchToolRegistry`
      );
    }
  });

  it("[tools] no allowlisted tool is exempted from the registry guard", () => {
    assert.equal(
      KNOWN_UNREGISTERED.size,
      0,
      "KNOWN_UNREGISTERED must stay empty — register the tool instead of pinning an exception"
    );
  });
});
