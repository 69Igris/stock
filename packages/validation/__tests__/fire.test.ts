/**
 * Negative / edge-case coverage for the REAL exported FIRE Zod schemas.
 *
 * Source: packages/validation/src/fire/index.ts
 *
 * Imports & exercises the actual schemas (no shadow). Covers the bounded age /
 * rate ranges, the cross-field `.refine()` (retirementAge >= currentAge), and
 * the MONEY-620 `.finite()` guards on the upper-unbounded monetary fields
 * (currentCorpus, monthlySavings, expense amount/cost) so an `Infinity` can no
 * longer flow into the FIRE projection math.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MonthlyExpenseSchema,
  OneTimeExpenseSchema,
  FireParametersSchema,
  FireScenarioSchema,
} from "../src/fire/index.ts";

describe("MonthlyExpenseSchema (real export)", () => {
  const valid = { id: "e1", category: "Food", amount: 20000 };

  it("accepts a valid monthly expense and applies inflation default", () => {
    const r = MonthlyExpenseSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.inflation, 6);
  });

  it("accepts a zero amount (non-negative boundary)", () => {
    const r = MonthlyExpenseSchema.safeParse({ ...valid, amount: 0 });
    assert.equal(r.success, true);
  });

  it("rejects empty category", () => {
    const r = MonthlyExpenseSchema.safeParse({ ...valid, category: "" });
    assert.equal(r.success, false);
  });

  it("rejects negative amount", () => {
    const r = MonthlyExpenseSchema.safeParse({ ...valid, amount: -1 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity amount — MONEY-620 .finite() guard", () => {
    const r = MonthlyExpenseSchema.safeParse({ ...valid, amount: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects inflation above 30", () => {
    const r = MonthlyExpenseSchema.safeParse({ ...valid, inflation: 31 });
    assert.equal(r.success, false);
  });
});

describe("OneTimeExpenseSchema (real export)", () => {
  const valid = { id: "o1", name: "Car", currentCost: 1000000, yearsAway: 5 };

  it("accepts a valid one-time expense", () => {
    const r = OneTimeExpenseSchema.safeParse(valid);
    assert.equal(r.success, true);
  });

  it("rejects empty name", () => {
    const r = OneTimeExpenseSchema.safeParse({ ...valid, name: "" });
    assert.equal(r.success, false);
  });

  it("rejects zero currentCost (must be positive)", () => {
    const r = OneTimeExpenseSchema.safeParse({ ...valid, currentCost: 0 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity currentCost — MONEY-620 .finite() guard", () => {
    const r = OneTimeExpenseSchema.safeParse({
      ...valid,
      currentCost: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects yearsAway below 1", () => {
    const r = OneTimeExpenseSchema.safeParse({ ...valid, yearsAway: 0 });
    assert.equal(r.success, false);
  });

  it("rejects yearsAway above 50", () => {
    const r = OneTimeExpenseSchema.safeParse({ ...valid, yearsAway: 51 });
    assert.equal(r.success, false);
  });
});

describe("FireParametersSchema (real export)", () => {
  const valid = {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 500000,
    monthlySavings: 50000,
    withdrawalRate: 4,
    salaryIncrement: 8,
    savingsIncrement: 10,
  };

  it("accepts a fully valid parameter set", () => {
    const r = FireParametersSchema.safeParse(valid);
    assert.equal(r.success, true);
  });

  it("rejects currentAge below 18", () => {
    const r = FireParametersSchema.safeParse({ ...valid, currentAge: 17 });
    assert.equal(r.success, false);
  });

  it("rejects currentAge above 80", () => {
    const r = FireParametersSchema.safeParse({ ...valid, currentAge: 81 });
    assert.equal(r.success, false);
  });

  it("rejects withdrawalRate below 1%", () => {
    const r = FireParametersSchema.safeParse({ ...valid, withdrawalRate: 0.5 });
    assert.equal(r.success, false);
  });

  it("rejects withdrawalRate above 25%", () => {
    const r = FireParametersSchema.safeParse({ ...valid, withdrawalRate: 26 });
    assert.equal(r.success, false);
  });

  it("rejects negative currentCorpus", () => {
    const r = FireParametersSchema.safeParse({ ...valid, currentCorpus: -1 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity currentCorpus — MONEY-620 .finite() guard", () => {
    const r = FireParametersSchema.safeParse({
      ...valid,
      currentCorpus: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects Infinity monthlySavings — MONEY-620 .finite() guard", () => {
    const r = FireParametersSchema.safeParse({
      ...valid,
      monthlySavings: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects NaN monthlySavings", () => {
    const r = FireParametersSchema.safeParse({ ...valid, monthlySavings: NaN });
    assert.equal(r.success, false);
  });

  it("rejects retirementAge < currentAge (cross-field refine)", () => {
    const r = FireParametersSchema.safeParse({
      ...valid,
      currentAge: 45,
      retirementAge: 40,
    });
    assert.equal(r.success, false);
    if (r.success) return;
    // refine attaches the issue to retirementAge
    assert.equal(
      r.error.issues.some((i) => i.path.includes("retirementAge")),
      true,
    );
  });

  it("accepts retirementAge === currentAge (boundary of refine)", () => {
    const r = FireParametersSchema.safeParse({
      ...valid,
      currentAge: 40,
      retirementAge: 40,
    });
    assert.equal(r.success, true);
  });

  it("rejects a missing required field (currentAge absent)", () => {
    const { currentAge: _omit, ...rest } = valid;
    void _omit;
    const r = FireParametersSchema.safeParse(rest);
    assert.equal(r.success, false);
  });
});

describe("FireScenarioSchema (real export)", () => {
  const valid = {
    name: "Aggressive",
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 500000,
    monthlySavings: 50000,
    assetClasses: [
      {
        id: "eq",
        name: "Equity",
        icon: "trend",
        allocation: 70,
        expectedReturn: 12,
        color: "#000000",
      },
    ],
    expenses: [],
    oneTimeExpenses: [],
  };

  it("accepts a valid scenario and applies rate defaults", () => {
    const r = FireScenarioSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.withdrawalRate, 4);
  });

  it("rejects empty name", () => {
    const r = FireScenarioSchema.safeParse({ ...valid, name: "" });
    assert.equal(r.success, false);
  });

  it("rejects an asset allocation above 100", () => {
    const r = FireScenarioSchema.safeParse({
      ...valid,
      assetClasses: [{ ...valid.assetClasses[0], allocation: 101 }],
    });
    assert.equal(r.success, false);
  });

  it("rejects an expectedReturn below the -20 floor", () => {
    const r = FireScenarioSchema.safeParse({
      ...valid,
      assetClasses: [{ ...valid.assetClasses[0], expectedReturn: -21 }],
    });
    assert.equal(r.success, false);
  });

  it("rejects Infinity currentCorpus — MONEY-620 .finite() guard", () => {
    const r = FireScenarioSchema.safeParse({
      ...valid,
      currentCorpus: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects retirementAge < currentAge (cross-field refine)", () => {
    const r = FireScenarioSchema.safeParse({
      ...valid,
      currentAge: 45,
      retirementAge: 40,
    });
    assert.equal(r.success, false);
  });

  it("rejects assetClasses that is not an array", () => {
    const r = FireScenarioSchema.safeParse({ ...valid, assetClasses: {} });
    assert.equal(r.success, false);
  });

  it("propagates a malformed nested expense (invalid MonthlyExpense)", () => {
    const r = FireScenarioSchema.safeParse({
      ...valid,
      expenses: [{ id: "x", category: "", amount: -5 }],
    });
    assert.equal(r.success, false);
  });
});
