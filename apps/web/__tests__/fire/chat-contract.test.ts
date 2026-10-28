/**
 * Ask FIRE chat — CONTRACT tests (MONEY-1049).
 *
 * The chat spans four layers that must stay in lock-step:
 *   tools.ts (Gemini FunctionDeclarations) → toolExecutor.ts (dispatch)
 *   → actions.ts (FireChatActions) → bridge/page.
 *
 * This suite pins the cross-layer contract so drift fails loudly:
 *   1. Gemini schema validity — every declared `parameters` is an OBJECT
 *      with ≥1 property (Gemini 400s an empty-properties OBJECT, which
 *      would fail EVERY chat request), `required` ⊆ properties, and the
 *      no-arg `resetAll` omits `parameters` entirely.
 *   2. Tool names are unique.
 *   3. Every declared tool round-trips through the REAL executor with
 *      schema-shaped args and reaches a FireChatActions method.
 *   4. Every FireChatActions method is reachable from some declared tool
 *      (no orphaned contract methods), and unknown tool names error.
 *
 * Sources: apps/web/app/fire/lib/chat/{tools,toolExecutor,actions}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@google/genai";

import { FIRE_TOOLS } from "@/app/fire/lib/chat/tools";
import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import type { FireChatActions } from "@/app/fire/lib/chat/actions";

/** Recording mock where every by-name lookup succeeds. */
function makeRecordingActions() {
  const called = new Set<string>();
  const hit =
    (name: string, ret?: unknown) =>
    (..._args: unknown[]) => {
      called.add(name);
      return ret as never;
    };
  const actions: FireChatActions = {
    // MONEY-1079 — contract gained readValues() so the executor can report a
    // change as "from <old> to <new>". These suites assert the value handed to
    // each setter, so a zeroed baseline is sufficient here.
    readValues: () => ({
      currentAge: 0,
      retirementAge: 0,
      lifeExpectancy: 0,
      currentCorpus: 0,
      monthlySavings: 0,
      withdrawalRate: 0,
      taxRate: 0,
      salaryIncrement: 0,
      savingsIncrement: 0,
    }),
    setCurrentAge: hit("setCurrentAge"),
    setRetirementAge: hit("setRetirementAge"),
    setLifeExpectancy: hit("setLifeExpectancy"),
    setCurrentCorpus: hit("setCurrentCorpus"),
    setMonthlySavings: hit("setMonthlySavings"),
    setSafeWithdrawalRate: hit("setSafeWithdrawalRate"),
    setTaxRate: hit("setTaxRate"),
    setSalaryIncrement: hit("setSalaryIncrement"),
    setSavingsIncrement: hit("setSavingsIncrement"),
    addAssetClass: hit("addAssetClass"),
    updateAssetAllocationByName: hit("updateAssetAllocationByName", true),
    updateAssetReturnByName: hit("updateAssetReturnByName", true),
    removeAssetClassByName: hit("removeAssetClassByName", true),
    addExpense: hit("addExpense"),
    updateExpenseByCategory: hit("updateExpenseByCategory", true),
    removeExpenseByCategory: hit("removeExpenseByCategory", true),
    addOneTimeGoal: hit("addOneTimeGoal"),
    updateOneTimeGoalByName: hit("updateOneTimeGoalByName", true),
    removeOneTimeGoalByName: hit("removeOneTimeGoalByName", true),
    saveScenario: (async () => {
      called.add("saveScenario");
      return true;
    }) as FireChatActions["saveScenario"],
    loadScenarioByName: (async () => {
      called.add("loadScenarioByName");
      return true;
    }) as FireChatActions["loadScenarioByName"],
    resetAll: hit("resetAll") as FireChatActions["resetAll"],
  };
  return { actions, called };
}

/**
 * Read-only contract members. They exist so the executor can report a change as
 * "from <old> to <new>" (MONEY-1079); the model never invokes them, so they are
 * deliberately exempt from the "every method has a tool" rule below. Listing
 * them by name keeps the invariant strict — a new MUTATION with no tool still
 * fails, and exempting a method stays an explicit decision.
 */
const READ_ONLY_METHODS = new Set<keyof FireChatActions>(["readValues"]);

const ALL_ACTION_METHODS = (
  Object.keys(makeRecordingActions().actions) as (keyof FireChatActions)[]
).filter((m) => !READ_ONLY_METHODS.has(m));

/** Build schema-shaped args for a declaration (values valid per description). */
function argsFor(tool: (typeof FIRE_TOOLS)[number]): Record<string, unknown> {
  const props = tool.parameters?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    const s = schema as { type?: Type };
    if (s.type === Type.NUMBER) {
      // 5 satisfies every declared numeric range (ages use 45 instead).
      out[key] =
        key === "age"
          ? 45
          : key === "yearsAway"
            ? 5
            : key === "amount" || key === "currentCost"
              ? 50000
              : 5;
    } else {
      out[key] =
        key === "category" ? "Housing" : key === "icon" ? "💰" : "Equity";
    }
  }
  return out;
}

describe("contract — Gemini schema validity", () => {
  it("tool names are unique", () => {
    const names = FIRE_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("every parameters schema is an OBJECT with ≥1 property (Gemini rejects empty)", () => {
    for (const t of FIRE_TOOLS) {
      if (!t.parameters) continue;
      assert.equal(t.parameters.type, Type.OBJECT, t.name);
      const props = Object.keys(t.parameters.properties ?? {});
      assert.ok(props.length > 0, `${t.name} has an empty-properties OBJECT`);
    }
  });

  it("required ⊆ declared properties, and every property is NUMBER or STRING", () => {
    for (const t of FIRE_TOOLS) {
      if (!t.parameters) continue;
      const props = t.parameters.properties ?? {};
      for (const r of t.parameters.required ?? []) {
        assert.ok(r in props, `${t.name}: required "${r}" not declared`);
      }
      for (const [k, v] of Object.entries(props)) {
        const ty = (v as { type?: Type }).type;
        assert.ok(
          ty === Type.NUMBER || ty === Type.STRING,
          `${t.name}.${k} has unexpected type ${String(ty)}`
        );
      }
    }
  });

  it("resetAll (no-arg tool) omits parameters entirely", () => {
    const reset = FIRE_TOOLS.find((t) => t.name === "resetAll");
    assert.ok(reset);
    assert.equal(reset.parameters, undefined);
  });

  it("every tool has a name and a description", () => {
    for (const t of FIRE_TOOLS) {
      assert.ok(t.name && t.name.length > 0);
      assert.ok(t.description && t.description.length > 10, t.name);
    }
  });
});

describe("contract — every declared tool executes through the real executor", () => {
  for (const tool of FIRE_TOOLS) {
    it(`${tool.name} round-trips with schema-shaped args`, async () => {
      const { actions, called } = makeRecordingActions();
      const result = await executeFireTool(tool.name!, argsFor(tool), actions);
      assert.equal(
        result.ok,
        true,
        `executor rejected ${tool.name}: ${result.ok ? "" : result.error}`
      );
      assert.ok(called.size >= 1, `${tool.name} reached no action method`);
    });
  }
});

describe("contract — reachability & unknowns", () => {
  it("every FireChatActions method is reachable from some declared tool", async () => {
    const reached = new Set<string>();
    for (const tool of FIRE_TOOLS) {
      const { actions, called } = makeRecordingActions();
      await executeFireTool(tool.name!, argsFor(tool), actions);
      for (const m of called) reached.add(m);
    }
    for (const method of ALL_ACTION_METHODS) {
      assert.ok(
        reached.has(method),
        `actions.${String(method)} is not reachable from any declared tool`
      );
    }
  });

  it("an undeclared tool name errors instead of silently no-opping", async () => {
    const { actions } = makeRecordingActions();
    const r = await executeFireTool("frobnicate", {}, actions);
    assert.equal(r.ok, false);
  });

  it("missing required args error and never dispatch", async () => {
    for (const tool of FIRE_TOOLS) {
      const required = tool.parameters?.required ?? [];
      if (required.length === 0) continue;
      const { actions, called } = makeRecordingActions();
      const r = await executeFireTool(tool.name!, {}, actions);
      assert.equal(r.ok, false, `${tool.name} accepted empty args`);
      assert.equal(called.size, 0, `${tool.name} dispatched despite bad args`);
    }
  });
});
