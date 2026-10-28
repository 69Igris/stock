/**
 * serverPlanToScenarioInput — denormalized headline fields (MONEY-1079).
 *
 * THE BUG: the mobile turn route persisted a chat edit via
 * `serverPlanToScenarioInput`, which wrote the plan INPUTS but omitted the four
 * denormalized outcome columns (fireNumber, yearsToFire, avgInflation,
 * weightedReturn). `saveFireScenario` uses Prisma `updateMany`, which SKIPS
 * undefined — so those four silently kept their PRE-mutation values. A user who
 * raised monthly savings from ₹60k to ₹1L got the new input stored beside a
 * yearsToFire still computed from ₹60k, and GET /v1/fire served that
 * contradiction. The /fire page never had it: client.tsx writes all four on
 * every save.
 *
 * THE FIX: serverPlanToScenarioInput computes them itself, from the SAME
 * `computeFirePlanOutcomes` the model's snapshot uses — so the stored headline
 * and the on-screen headline cannot disagree, and every caller (present or
 * future) is correct by construction rather than by remembering.
 *
 * These assert the fields TRACK THE PLAN rather than pinning magic constants:
 * a change to the FIRE math should not break this suite, but a regression that
 * drops or staleness the fields must.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { serverPlanToScenarioInput } from "@/app/fire/lib/chat/scenarioTarget";
import { defaultServerFirePlan } from "@/app/fire/lib/chat/serverActions";
import { buildFireSnapshotFromPlan } from "@/app/fire/lib/chat/serverSnapshot";

describe("MONEY-1079 — the four denormalized fields are always written", () => {
  it("emits all four (never undefined → never skipped by Prisma updateMany)", () => {
    const input = serverPlanToScenarioInput(defaultServerFirePlan(), "Base");

    for (const key of [
      "fireNumber",
      "avgInflation",
      "weightedReturn",
    ] as const) {
      assert.equal(
        typeof input[key],
        "number",
        `${key} must be written, else updateMany leaves the stale value`
      );
      assert.ok(Number.isFinite(input[key] as number), `${key} must be finite`);
    }
    // yearsToFire is undefined ONLY for the never-reaches sentinel (below).
    assert.equal(typeof input.yearsToFire, "number");
  });

  it("the stored headline MATCHES the snapshot the model reasons over", () => {
    // The whole point of computing both from computeFirePlanOutcomes: the row
    // and the chat cannot disagree about the same plan.
    const plan = defaultServerFirePlan();
    const input = serverPlanToScenarioInput(plan, "Base");
    const snapshot = buildFireSnapshotFromPlan(plan);

    assert.equal(
      Math.round(input.fireNumber as number),
      snapshot.computed.fireNumber
    );
    assert.equal(input.yearsToFire ?? null, snapshot.computed.yearsToFire);
  });

  it("raising monthly savings moves yearsToFire — the exact staleness bug", () => {
    const before = serverPlanToScenarioInput(
      { ...defaultServerFirePlan(), monthlySavings: 60_000 },
      "Base"
    );
    const after = serverPlanToScenarioInput(
      { ...defaultServerFirePlan(), monthlySavings: 100_000 },
      "Base"
    );

    assert.ok(
      (after.yearsToFire as number) < (before.yearsToFire as number),
      `saving more must shorten the horizon: ${before.yearsToFire} → ${after.yearsToFire}`
    );
  });

  it("changing expenses moves avgInflation; changing assets moves weightedReturn", () => {
    const base = defaultServerFirePlan();

    const pricier = serverPlanToScenarioInput(
      {
        ...base,
        monthlyExpenses: base.monthlyExpenses.map((e, i) =>
          i === 0 ? { ...e, inflation: e.inflation + 5 } : e
        ),
      },
      "Base"
    );
    assert.notEqual(
      pricier.avgInflation,
      serverPlanToScenarioInput(base, "Base").avgInflation
    );

    const riskier = serverPlanToScenarioInput(
      {
        ...base,
        assetClasses: base.assetClasses.map((a, i) =>
          i === 0 ? { ...a, expectedReturn: a.expectedReturn + 5 } : a
        ),
      },
      "Base"
    );
    assert.notEqual(
      riskier.weightedReturn,
      serverPlanToScenarioInput(base, "Base").weightedReturn
    );
  });

  it("the 999 never-reaches sentinel is stored as undefined, not as 999 years", () => {
    // No savings, no corpus, no growth → FIRE is never reached. Storing 999
    // would render as "999 years to FIRE" in the app; client.tsx maps it to
    // undefined and this must match.
    const hopeless = serverPlanToScenarioInput(
      {
        ...defaultServerFirePlan(),
        currentCorpus: 0,
        monthlySavings: 0,
        savingsIncrement: 0,
        assetClasses: [
          {
            id: "a1",
            name: "Cash",
            icon: "💵",
            allocation: 100,
            expectedReturn: 0,
            color: "#64748b",
          },
        ],
      },
      "Hopeless"
    );

    // MUST be `null`, not `undefined`. This assertion previously pinned
    // `undefined`, which encoded a bug rather than a contract:
    // saveFireScenario persists with Prisma `updateMany`, and updateMany
    // SKIPS undefined fields — so a plan that just became unreachable kept
    // its PREVIOUS horizon stored beside the new inputs ("reaches FIRE in 8
    // years" next to a plan that never does). `null` writes an explicit NULL
    // and actually clears the column.
    assert.equal(hopeless.yearsToFire, null);
    // the other three are still written
    assert.equal(typeof hopeless.fireNumber, "number");
    assert.equal(typeof hopeless.weightedReturn, "number");
  });

  it("plan inputs still round-trip unchanged (no regression in the mapping)", () => {
    const plan = { ...defaultServerFirePlan(), monthlySavings: 123_456 };
    const input = serverPlanToScenarioInput(plan, "My Plan", "notes");

    assert.equal(input.name, "My Plan");
    assert.equal(input.description, "notes");
    assert.equal(input.monthlySavings, 123_456);
    assert.equal(input.currentAge, plan.currentAge);
    assert.equal(input.taxRate, plan.taxRate);
  });
});
