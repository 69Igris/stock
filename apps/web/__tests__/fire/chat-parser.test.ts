/**
 * FIRE deterministic command parser — UNIT tests (StockSage integration).
 *
 * Tier 1 of "functions if possible, else LLM": maps unambiguous single-intent
 * commands to tool calls with ZERO model cost. Precision is the whole game — a
 * wrong parse silently moves a real slider — so this suite is deliberately
 * heavy on the NEGATIVE side (must return null → fall through to the LLM) as
 * well as the positive parses and the INR/percent number handling.
 *
 * Source: apps/web/app/fire/lib/chat/parser.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseFireCommand, parseInrAmount } from "@/app/fire/lib/chat/parser";
import type { FireSnapshot } from "@/app/fire/lib/chat/systemPrompt";

const SNAP: FireSnapshot = {
  parameters: {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    safeWithdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
  },
  assetClasses: [
    { name: "Equity", allocation: 60, expectedReturn: 12 },
    { name: "Gold", allocation: 10, expectedReturn: 8 },
    { name: "Fixed Deposits", allocation: 15, expectedReturn: 7 },
    { name: "Cash", allocation: 5, expectedReturn: 4 },
    { name: "Real Estate", allocation: 10, expectedReturn: 9 },
  ],
  expenses: [
    { category: "Housing", amount: 25000, inflation: 5 },
    { category: "Groceries", amount: 12000, inflation: 6 },
  ],
  oneTimeGoals: [
    { name: "Europe trip", currentCost: 800000, yearsAway: 5, inflation: 6 },
  ],
  savedScenarios: [{ name: "Aggressive" }, { name: "Base" }],
  computed: {
    fireNumber: 10_000_000,
    yearsToFire: 12,
    corpusAtRetirement: 12_000_000,
    fireAchievedAtRetirement: true,
    surplusAtRetirement: 2_000_000,
    sustainableMonthlySpend: 80_000,
    swrComparisonFireNumber: 9_000_000,
    firstShortfallAge: null,
  },
};

const parse = (t: string) => parseFireCommand(t, SNAP);
const call = (t: string) => parse(t)?.functionCalls[0];

// ── INR number parsing (unit) ──────────────────────────────────────────

describe("parseInrAmount", () => {
  const cases: [string, number | null][] = [
    ["55 lakh", 5_500_000],
    ["1.2 cr", 12_000_000],
    ["1.2 crore", 12_000_000],
    ["90k", 90_000],
    ["₹15,000", 15_000],
    ["1,80,000", 180_000],
    ["₹1,80,000", 180_000],
    ["5000", 5_000],
    ["5 lac", 500_000],
    ["2 million", 2_000_000],
    ["", null],
    ["abc", null],
    ["ten lakh", null], // words not supported → LLM
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.equal(parseInrAmount(input), expected);
    });
  }
});

// ── parameter setters (positive) ───────────────────────────────────────

describe("parser — parameters", () => {
  it("retirement age variants → setRetirementAge", () => {
    for (const t of [
      "set my retirement age to 45",
      "retire at 45",
      "retire by 45",
      "retirement age 45",
    ]) {
      assert.deepEqual(
        call(t),
        { name: "setRetirementAge", args: { age: 45 } },
        t
      );
    }
  });

  it("current age → setCurrentAge (NOT confused with retirement age)", () => {
    assert.deepEqual(call("set my current age to 33"), {
      name: "setCurrentAge",
      args: { age: 33 },
    });
    assert.deepEqual(call("set age to 33"), {
      name: "setCurrentAge",
      args: { age: 33 },
    });
    // the retirement matcher must win here:
    assert.equal(call("set retirement age to 45")!.name, "setRetirementAge");
  });

  it("life expectancy → setLifeExpectancy", () => {
    assert.deepEqual(call("set life expectancy to 90"), {
      name: "setLifeExpectancy",
      args: { age: 90 },
    });
    assert.deepEqual(call("live till 92"), {
      name: "setLifeExpectancy",
      args: { age: 92 },
    });
  });

  it("corpus with lakh/crore units → setCurrentCorpus", () => {
    assert.deepEqual(call("set corpus to 55 lakh"), {
      name: "setCurrentCorpus",
      args: { amount: 5_500_000 },
    });
    assert.deepEqual(call("my current corpus is 1.2 crore"), {
      name: "setCurrentCorpus",
      args: { amount: 12_000_000 },
    });
    // number-grouping commas must NOT be read as a compound separator
    assert.deepEqual(call("set corpus to ₹1,80,000"), {
      name: "setCurrentCorpus",
      args: { amount: 180_000 },
    });
  });

  it("SIP / monthly savings with k → setMonthlySavings", () => {
    assert.deepEqual(call("set SIP to 90k"), {
      name: "setMonthlySavings",
      args: { amount: 90_000 },
    });
    assert.deepEqual(call("monthly savings 1.2 lakh"), {
      name: "setMonthlySavings",
      args: { amount: 120_000 },
    });
    assert.deepEqual(call("save 75000 per month"), {
      name: "setMonthlySavings",
      args: { amount: 75_000 },
    });
  });

  it("SWR / tax / increments → percent setters", () => {
    assert.deepEqual(call("set safe withdrawal rate to 3.5%"), {
      name: "setSafeWithdrawalRate",
      args: { percent: 3.5 },
    });
    assert.deepEqual(call("swr 3"), {
      name: "setSafeWithdrawalRate",
      args: { percent: 3 },
    });
    assert.deepEqual(call("set tax rate to 20%"), {
      name: "setTaxRate",
      args: { percent: 20 },
    });
    assert.deepEqual(call("salary increment 12%"), {
      name: "setSalaryIncrement",
      args: { percent: 12 },
    });
    assert.deepEqual(call("savings increment 9"), {
      name: "setSavingsIncrement",
      args: { percent: 9 },
    });
  });

  it("directional verb + explicit absolute target still fast-paths", () => {
    // "reduce"/"increase" are safe because the matcher reads the "to N" target.
    assert.deepEqual(call("reduce equity to 40%"), {
      name: "updateAssetAllocation",
      args: { name: "Equity", allocation: 40 },
    });
    assert.deepEqual(call("increase groceries to 20000"), {
      name: "updateExpense",
      args: { category: "Groceries", amount: 20_000 },
    });
  });
});

// ── collections by name (positive) ─────────────────────────────────────

describe("parser — assets / expenses / goals by name", () => {
  it("asset allocation by name (multi-word names resolve)", () => {
    assert.deepEqual(call("set equity to 70%"), {
      name: "updateAssetAllocation",
      args: { name: "Equity", allocation: 70 },
    });
    assert.deepEqual(call("fixed deposits to 25%"), {
      name: "updateAssetAllocation",
      args: { name: "Fixed Deposits", allocation: 25 },
    });
  });

  it("asset expected return → updateAssetReturn (not allocation)", () => {
    assert.deepEqual(call("set gold expected return to 9%"), {
      name: "updateAssetReturn",
      args: { name: "Gold", expectedReturn: 9 },
    });
  });

  it("remove asset / expense / goal by name", () => {
    assert.deepEqual(call("remove Real Estate"), {
      name: "removeAssetClass",
      args: { name: "Real Estate" },
    });
    assert.deepEqual(call("delete Groceries"), {
      name: "removeExpense",
      args: { category: "Groceries" },
    });
    assert.deepEqual(call("remove the Europe trip"), {
      name: "removeOneTimeGoal",
      args: { name: "Europe trip" },
    });
  });

  it("expense inflation vs amount", () => {
    assert.deepEqual(call("set Housing inflation to 8%"), {
      name: "updateExpense",
      args: { category: "Housing", inflation: 8 },
    });
    assert.deepEqual(call("set Housing to 30000"), {
      name: "updateExpense",
      args: { category: "Housing", amount: 30_000 },
    });
  });
});

// ── scenarios / control (positive) ─────────────────────────────────────

describe("parser — scenarios & reset", () => {
  it("save scenario (name may contain otherwise-fuzzy words)", () => {
    assert.deepEqual(call('save this as "Aggressive plan"'), {
      name: "saveScenario",
      args: { name: "Aggressive plan" },
    });
    assert.deepEqual(call("save as Plan B"), {
      name: "saveScenario",
      args: { name: "Plan B" },
    });
  });

  it("load scenario resolves against saved names", () => {
    assert.deepEqual(call("load Aggressive"), {
      name: "loadScenario",
      args: { name: "Aggressive" },
    });
    assert.deepEqual(call("switch to Base"), {
      name: "loadScenario",
      args: { name: "Base" },
    });
    // unknown scenario name → no fast-path (LLM can clarify)
    assert.equal(parse("load Nonexistent"), null);
  });

  it("reset", () => {
    for (const t of ["reset everything", "reset to defaults", "start over"]) {
      assert.deepEqual(call(t), { name: "resetAll", args: {} }, t);
    }
  });
});

// ── fall-through: MUST return null (→ LLM) ─────────────────────────────

describe("parser — bails to the LLM (null) on anything ambiguous", () => {
  const bail = [
    // questions / assessments
    "how am I doing?",
    "can I retire at 45?",
    "is my equity allocation too high?",
    "what's my FIRE number?",
    "explain the 4% rule",
    // fuzzy intent (no concrete value)
    "make my plan more conservative",
    "make it aggressive",
    "optimize my allocation",
    "am I on track?",
    "will I run out of money?",
    // relative (would misparse as absolute)
    "increase equity by 10",
    "10% more into gold",
    "double my SIP",
    "save a bit more each month",
    // compound (v1 does not fast-path multi-intent)
    "set retirement to 45 and SIP to 90k",
    "lower equity to 40% and raise gold to 20%",
    // comma-separated compound — MUST fall through, NOT fast-path the
    // trailing "save as X" (regression: it once saved and dropped the rest)
    "set age 33, corpus 55L, SIP 95k, retire 46, save as Master22",
    "set equity to 60%, gold to 12%",
    "retire at 46, save as Plan Z",
    // hypothetical (LLM should call the setter + comment)
    "what if I retire at 45?",
    // multi-param adds (deferred to LLM in v1)
    "add a Travel expense of 15000 at 7%",
    "add a Crypto asset at 10% with 20% return",
    // genuinely unknown / chit-chat
    "hello",
    "thanks!",
    "",
    "tell me about SWR",
  ];
  for (const t of bail) {
    it(`"${t}" → null`, () => {
      assert.equal(parse(t), null);
    });
  }
});

describe("parser — telemetry surface", () => {
  it("returns the matcher id on a hit (for hit-rate logging)", () => {
    const r = parse("retire at 45");
    assert.ok(r);
    assert.equal(r.matcher, "retirementAge");
  });
});
