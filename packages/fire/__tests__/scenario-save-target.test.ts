/**
 * `createScenarioOps` — SAVE-TARGET regression tests (MONEY-1079).
 *
 * ## The bug these exist for
 *
 * `POST /v1/fire/:id/turn` runs a chat turn against the scenario named in the
 * path, then persists the mutated plan. The FIRE engine also lets a turn LOAD
 * a different saved scenario, and `ServerFireActions.loadScenarioByName`
 * implements that by `Object.assign`ing the loaded plan OVER the working copy.
 *
 * So after a load, `actions.plan` holds the LOADED scenario's numbers while
 * the request path still names a different one. Persisting to the path id at
 * that point overwrites it with another plan's data:
 *
 *     POST /v1/fire/<A>/turn   { request: "load my Conservative plan" }
 *     → plan A permanently replaced by plan B's numbers
 *
 * That is silent, permanent data loss on a money feature — no error, no 4xx,
 * and the response even looks correct because it echoes the loaded plan.
 *
 * ## What is actually pinned
 *
 * The invariant is NOT "getSaveTarget returns the loaded id" (that would just
 * restate the implementation). It is:
 *
 *     the plan being persisted and the target it is persisted to
 *     always describe the SAME scenario
 *
 * so the tests assert plan CONTENT against target identity together, and the
 * clobber case asserts what would have been written to the wrong row.
 *
 * The ops are driven through the REAL `ServerFireActions` rather than called
 * directly, because the `Object.assign`-over-the-working-copy behaviour is
 * exactly what makes the bug possible — a test that skipped it would pass
 * against the broken code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FireScenario, FireScenarioInput } from "@usemoney/services/fire";

import { createScenarioOps, scenarioToServerPlan } from "../src/scenarioTarget";
import { ServerFireActions } from "../src/serverActions";

/* ── fixtures ────────────────────────────────────────────────────────── */

/**
 * Two plans that differ in every field the save would clobber, so an
 * assertion can never pass by coincidence.
 */
function scenario(
  id: string,
  name: string,
  overrides: Partial<FireScenario> = {},
): FireScenario {
  return {
    id,
    userId: "u_1",
    name,
    description: null,
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: [],
    expenses: [],
    oneTimeExpenses: [],
    fireNumber: null,
    yearsToFire: null,
    monthlyExpenses: null,
    avgInflation: null,
    weightedReturn: null,
    chatHistory: [],
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** The scenario in the request path. */
const PLAN_A = scenario("id_a", "Aggressive", {
  currentAge: 30,
  retirementAge: 45,
  currentCorpus: 5_000_000,
  monthlySavings: 150_000,
});

/** A different saved plan the turn may load. */
const PLAN_B = scenario("id_b", "Conservative", {
  currentAge: 41,
  retirementAge: 60,
  currentCorpus: 900_000,
  monthlySavings: 25_000,
});

const SAVED = [PLAN_A, PLAN_B];
const PATH = { id: PLAN_A.id, name: PLAN_A.name };

/** Wire the ops exactly as the route does, recording any create-new calls. */
function build() {
  const created: FireScenarioInput[] = [];
  const { ops, getSaveTarget } = createScenarioOps({
    saved: SAVED,
    pathScenario: PATH,
    persistNew: async (input) => {
      created.push(input);
      return true;
    },
  });
  // Drive through the REAL actions object — see the header note.
  const actions = new ServerFireActions(scenarioToServerPlan(PLAN_A), ops);
  return { actions, getSaveTarget, created };
}

/* ── tests ───────────────────────────────────────────────────────────── */

describe("createScenarioOps — save target (MONEY-1079)", () => {
  it("stays on the path scenario when the turn loads nothing", async () => {
    const { actions, getSaveTarget } = build();
    actions.setMonthlySavings(200_000);

    assert.deepEqual(getSaveTarget(), PATH);
    // Plan is still A's, edited — so plan and target agree.
    assert.equal(actions.plan.retirementAge, PLAN_A.retirementAge);
    assert.equal(actions.plan.monthlySavings, 200_000);
  });

  it("re-points the save at the scenario a load pulled in", async () => {
    const { actions, getSaveTarget } = build();

    const ok = await actions.loadScenarioByName("Conservative");
    assert.equal(ok, true);

    // THE invariant: the working plan is now B's, so the target must be B.
    assert.deepEqual(getSaveTarget(), { id: PLAN_B.id, name: PLAN_B.name });
    assert.equal(actions.plan.currentAge, PLAN_B.currentAge);
    assert.equal(actions.plan.retirementAge, PLAN_B.retirementAge);
    assert.equal(actions.plan.currentCorpus, PLAN_B.currentCorpus);
    assert.equal(actions.plan.monthlySavings, PLAN_B.monthlySavings);
  });

  it("would otherwise have written B's numbers into A (the data loss)", async () => {
    const { actions, getSaveTarget } = build();
    await actions.loadScenarioByName("Conservative");

    // Spell out the destroyed state the fix prevents: persisting the working
    // plan to the PATH id after a load would replace A wholesale with B.
    const target = getSaveTarget();
    assert.notEqual(
      target.id,
      PATH.id,
      "saving to the path id here would overwrite Aggressive with Conservative",
    );
    assert.notEqual(actions.plan.currentCorpus, PLAN_A.currentCorpus);
    assert.equal(actions.plan.currentCorpus, PLAN_B.currentCorpus);
  });

  it("keeps the loaded target across subsequent edits (load, then edit)", async () => {
    const { actions, getSaveTarget } = build();
    await actions.loadScenarioByName("Conservative");
    actions.setMonthlySavings(70_000);
    actions.setRetirementAge(58);

    // Edits after a load belong to the loaded scenario, not the path one.
    assert.deepEqual(getSaveTarget(), { id: PLAN_B.id, name: PLAN_B.name });
    assert.equal(actions.plan.monthlySavings, 70_000);
    assert.equal(actions.plan.retirementAge, 58);
  });

  it("matches the name case-insensitively and ignores surrounding space", async () => {
    const { actions, getSaveTarget } = build();
    assert.equal(await actions.loadScenarioByName("  cOnSeRvAtIvE "), true);
    assert.equal(getSaveTarget().id, PLAN_B.id);
  });

  it("leaves the target alone when the requested name does not exist", async () => {
    const { actions, getSaveTarget } = build();

    assert.equal(await actions.loadScenarioByName("Nonexistent"), false);
    // A failed load must not move the target, and must not touch the plan.
    assert.deepEqual(getSaveTarget(), PATH);
    assert.equal(actions.plan.currentCorpus, PLAN_A.currentCorpus);
  });

  it("last load wins when a turn loads twice", async () => {
    const { actions, getSaveTarget } = build();
    await actions.loadScenarioByName("Conservative");
    await actions.loadScenarioByName("Aggressive");

    assert.deepEqual(getSaveTarget(), PATH);
    assert.equal(actions.plan.currentCorpus, PLAN_A.currentCorpus);
  });

  it("'save as <name>' creates a new scenario without re-pointing the target", async () => {
    const { actions, getSaveTarget, created } = build();
    actions.setMonthlySavings(180_000);

    assert.equal(await actions.saveScenario("Moonshot"), true);

    // The new row is created from the CURRENT working plan...
    assert.equal(created.length, 1);
    assert.equal(created[0]?.name, "Moonshot");
    assert.equal(created[0]?.monthlySavings, 180_000);
    // ...and the denormalized headline fields are serialized with it.
    assert.equal(typeof created[0]?.fireNumber, "number");
    // ...but the turn still belongs to the path scenario.
    assert.deepEqual(getSaveTarget(), PATH);
  });

  it("resetAll stays on the path scenario (deliberate, not data loss)", async () => {
    const { actions, getSaveTarget } = build();
    actions.resetAll();

    // "reset my plan" aimed at the path scenario is the correct reading of
    // the request — resetting must not wander to some other saved plan.
    assert.deepEqual(getSaveTarget(), PATH);
  });

  it("a load followed by resetAll still targets the loaded scenario", async () => {
    const { actions, getSaveTarget } = build();
    await actions.loadScenarioByName("Conservative");
    actions.resetAll();

    // The working copy is B's slot, so the reset belongs to B.
    assert.deepEqual(getSaveTarget(), { id: PLAN_B.id, name: PLAN_B.name });
  });
});
