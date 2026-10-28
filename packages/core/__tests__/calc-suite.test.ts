/**
 * Calculator suite - math correctness checks (MONEY-208).
 *
 * Each test pins the result against either Excel/Google Sheets or the
 * Dhan calculator UI so a numeric drift in our formulas is loud.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calcSip,
  calcLumpsum,
  calcStepUpSip,
  calcEmi,
  emiAmortisation,
  calcFd,
  calcRd,
  calcNps,
  calcGoalSip,
  calcInflationAdjustedSip,
  calcSwp,
  calcXirr,
  calcIncomeTax,
  calcCagr,
} from "../src/calc";

const CLOSE = 5000; // ₹ tolerance for compound math drift

describe("calcSip", () => {
  // The reference MOVED, and that is the whole point of this case.
  //
  // It used to assert ₹23,23,391 "(Dhan reference)" — an annuity-DUE figure,
  // contribution at the START of each month. SEBI's official investor
  // calculator uses an ordinary annuity (month END), which is what an Indian
  // retail investor checks the number against, and it gives ₹23,00,387 for
  // these inputs. The two differ by ₹23,004 on a ₹12,00,000 investment and the
  // gap widens with duration.
  //
  // Pinned against SEBI deliberately. If someone later "fixes" this back to a
  // broker's calculator, they are changing which authority the product agrees
  // with — a product decision, not a rounding tweak.
  it("₹10,000/mo × 10y at 12% = ₹23,00,387 (SEBI reference)", () => {
    const r = calcSip({
      monthly: 10_000,
      annualReturnPct: 12,
      durationYears: 10,
    });
    assert.strictEqual(r.invested, 1_200_000);
    assert.ok(
      Math.abs(r.finalValue - 2_300_387) < CLOSE,
      `expected ~23.0L (SEBI), got ${r.finalValue}`,
    );
  });

  it("the ₹5,000 case from the SEBI calculator, exactly", () => {
    // The figure the bug was reported against: the page showed ₹11,61,695
    // (annuity-due) where SEBI shows ₹11,50,193.
    const r = calcSip({
      monthly: 5_000,
      annualReturnPct: 12,
      durationYears: 10,
    });
    assert.strictEqual(r.invested, 600_000);
    assert.ok(
      Math.abs(r.finalValue - 1_150_193) < 2,
      `expected ₹11,50,193 (SEBI), got ${r.finalValue}`,
    );
    assert.ok(
      Math.abs(r.gain - 550_193) < 2,
      `expected gain ₹5,50,193, got ${r.gain}`,
    );
  });

  it("zero monthly returns zero", () => {
    const r = calcSip({ monthly: 0, annualReturnPct: 12, durationYears: 5 });
    assert.strictEqual(r.finalValue, 0);
  });

  it("zero return ⇒ FV = invested", () => {
    const r = calcSip({
      monthly: 5_000,
      annualReturnPct: 0,
      durationYears: 3,
    });
    assert.strictEqual(r.invested, 180_000);
    assert.strictEqual(r.finalValue, 180_000);
    assert.strictEqual(r.gain, 0);
  });
});

describe("calcLumpsum", () => {
  it("₹1L × 10y at 12% ≈ ₹3.106 L", () => {
    const r = calcLumpsum({
      principal: 100_000,
      annualReturnPct: 12,
      durationYears: 10,
    });
    assert.ok(Math.abs(r.finalValue - 310_584.82) < 100, `got ${r.finalValue}`);
  });

  it("zero principal returns zero", () => {
    const r = calcLumpsum({
      principal: 0,
      annualReturnPct: 10,
      durationYears: 5,
    });
    assert.strictEqual(r.finalValue, 0);
  });
});

describe("calcStepUpSip", () => {
  it("₹5k/mo × 15y at 12% with 10% step-up grows beyond plain SIP", () => {
    const stepUp = calcStepUpSip({
      monthly: 5000,
      annualReturnPct: 12,
      durationYears: 15,
      stepUpPct: 10,
    });
    const plain = calcSip({
      monthly: 5000,
      annualReturnPct: 12,
      durationYears: 15,
    });
    assert.ok(
      stepUp.finalValue > plain.finalValue,
      "step-up should outperform plain SIP",
    );
    assert.ok(
      stepUp.invested > plain.invested,
      "step-up invested should be more than plain",
    );
  });

  // The figures the step-up bug was reported against, with Groww's calculator
  // as the reference screenshot.
  //
  // INVESTED matches Groww to the rupee (₹38,12,698) — the step-up SCHEDULE was
  // never wrong. What differs is the growth model, and the divergence is
  // deliberate:
  //
  //   Groww  monthly rate = (1+R)^(1/12) − 1  (effective), annuity-DUE
  //          -> ₹82,74,718
  //   here   monthly rate = R/12              (nominal),   ordinary annuity
  //          -> ₹85,97,871
  //
  // SEBI's convention was chosen for the whole family so the calculators agree
  // with each other and with one authority. Matching Groww here would break the
  // "0% step-up == plain SIP" case below by ₹30,014, because plain SIP is
  // pinned to SEBI. Anyone changing this is picking a different authority for
  // the product, not correcting an error.
  it("₹10,000/mo, 10% step-up, 12%, 15y — SEBI convention", () => {
    const r = calcStepUpSip({
      monthly: 10_000,
      annualReturnPct: 12,
      stepUpPct: 10,
      durationYears: 15,
    });
    // Groww agrees exactly on this one: the contribution schedule is shared.
    assert.ok(
      Math.abs(r.invested - 3_812_698) < 2,
      `invested: expected ₹38,12,698 (matches Groww), got ${r.invested}`,
    );
    assert.ok(
      Math.abs(r.finalValue - 8_597_871) < 2,
      `total: expected ₹85,97,871 (SEBI convention), got ${r.finalValue}`,
    );
  });

  it("0% step-up reduces to plain SIP", () => {
    const stepUp = calcStepUpSip({
      monthly: 5000,
      annualReturnPct: 12,
      durationYears: 5,
      stepUpPct: 0,
    });
    const plain = calcSip({
      monthly: 5000,
      annualReturnPct: 12,
      durationYears: 5,
    });
    // Tightened from ₹100 to ₹1. Under one shared convention these are the
    // same number, and the loose tolerance could hide exactly the drift this
    // case exists to catch — the two use different implementations (closed form
    // vs monthly loop), so only the CONVENTION keeps them equal.
    assert.ok(
      Math.abs(stepUp.finalValue - plain.finalValue) < 1,
      `step-up ${stepUp.finalValue} vs plain ${plain.finalValue} — the two ` +
        `calculators have drifted apart on annuity timing or rate basis`,
    );
  });
});

describe("calcEmi", () => {
  it("₹50L home loan × 20y at 9% ≈ ₹44,986/mo (Dhan reference)", () => {
    const r = calcEmi({
      principal: 5_000_000,
      annualRatePct: 9,
      durationYears: 20,
    });
    assert.ok(Math.abs(r.emi - 44_986) < 50, `expected ~44986, got ${r.emi}`);
  });

  it("zero rate ⇒ EMI = principal / months", () => {
    const r = calcEmi({
      principal: 1_200_000,
      annualRatePct: 0,
      durationYears: 10,
    });
    assert.strictEqual(r.emi, 10_000);
  });

  it("amortisation: final balance ≈ 0", () => {
    const rows = emiAmortisation({
      principal: 1_000_000,
      annualRatePct: 8,
      durationYears: 5,
    });
    assert.strictEqual(rows.length, 60);
    const last = rows[rows.length - 1]!;
    assert.ok(
      last.remainingBalance < 1,
      `final balance should be ~0, got ${last.remainingBalance}`,
    );
  });
});

describe("calcFd", () => {
  // Labelled "(Dhan reference)" but this is the universal FD formula
  // P(1+r/n)^(nt) — there is no competing convention to choose between, and
  // SEBI, every bank and every broker agree. Relabelled so the reference set is
  // honest about which figures are a CHOICE and which are arithmetic.
  it("₹1L × 5y at 7% quarterly = ₹1,41,478 (standard FD compounding)", () => {
    const r = calcFd({
      principal: 100_000,
      annualRatePct: 7,
      durationYears: 5,
      compounding: "quarterly",
    });
    assert.ok(
      Math.abs(r.maturity - 141_478) < 200,
      `expected ~1.41L, got ${r.maturity}`,
    );
  });

  it("monthly compounding > quarterly > yearly for same rate", () => {
    const baseInput = {
      principal: 100_000,
      annualRatePct: 8,
      durationYears: 10,
    };
    const m = calcFd({ ...baseInput, compounding: "monthly" });
    const q = calcFd({ ...baseInput, compounding: "quarterly" });
    const y = calcFd({ ...baseInput, compounding: "yearly" });
    assert.ok(m.maturity > q.maturity, "monthly > quarterly");
    assert.ok(q.maturity > y.maturity, "quarterly > yearly");
  });
});

describe("calcRd", () => {
  // The tolerance here used to be ±₹6,000 ("RD compounding rules vary slightly
  // across banks"), and that window is exactly why this bug survived: the old
  // implementation over-credited by ₹1,909 on these inputs and the assertion
  // still passed. A tolerance wide enough to accommodate an unknown is wide
  // enough to accommodate a defect.
  //
  // Pinned to the standard Indian RD formula instead, to the rupee:
  //   M = R × [(1+i)^n − 1] / [1 − (1+i)^(−1/3)]
  it("₹5,000/mo × 5y at 6.5% = ₹3,54,954 (standard RD formula)", () => {
    const r = calcRd({
      monthly: 5_000,
      annualRatePct: 6.5,
      durationYears: 5,
    });
    assert.strictEqual(r.invested, 300_000);
    assert.ok(
      Math.abs(r.maturity - 354_954) < 2,
      `expected ₹3,54,954, got ${r.maturity}`,
    );
  });

  it("[regression] an instalment does not earn the quarter it is paid in", () => {
    // The defect, isolated. The old loop did `balance += monthly` and THEN
    // compounded every third month, so the month-3 deposit earned a full
    // quarter's interest having been on deposit for zero days.
    //
    // Three months, one compounding period: only the FIRST two instalments have
    // been held for any part of it, so maturity must be strictly less than
    // crediting all three a full quarter.
    const r = calcRd({
      monthly: 10_000,
      annualRatePct: 8,
      durationYears: 0.25,
    });
    const allThreeFullQuarter = 30_000 * (1 + 0.08 / 4);
    assert.ok(
      r.maturity < allThreeFullQuarter,
      `maturity ₹${r.maturity} credits every instalment a full quarter ` +
        `(₹${allThreeFullQuarter}) — the deposit-then-compound bug is back`,
    );
    assert.ok(r.maturity > 30_000, "three months must still earn something");
  });

  it("a zero rate returns the deposits untouched", () => {
    // The closed form divides by `1 - (1+i)^(-1/3)`, which is 0 at i = 0.
    const r = calcRd({ monthly: 5_000, annualRatePct: 0, durationYears: 5 });
    assert.strictEqual(r.maturity, 300_000);
    assert.strictEqual(r.interest, 0);
  });
});

describe("calcNps", () => {
  it("₹5k/mo × 30y at 10% with 60/40 split", () => {
    const r = calcNps({
      monthly: 5_000,
      currentAge: 30,
      retirementAge: 60,
      preReturnPct: 10,
      annuityRatePct: 6,
      annuityPct: 0.4,
    });
    assert.ok(r.corpus > 1_00_00_000, `corpus ${r.corpus} should exceed 1Cr`);
    assert.ok(
      Math.abs(r.annuityCorpus - r.corpus * 0.4) < 1,
      "annuity = 40% of corpus",
    );
    assert.ok(
      Math.abs(r.lumpsum - r.corpus * 0.6) < 1,
      "lumpsum = 60% of corpus",
    );
    assert.ok(r.monthlyPension > 0, "pension > 0");
  });
});

describe("calcGoalSip", () => {
  // ₹19,820 was the annuity-due answer. calcGoalSip is the exact rearrangement
  // of calcSip, so it moves with it — otherwise this returns a contribution
  // that calcSip then values at something other than the goal, and the
  // round-trip below would be the thing that broke.
  it("Goal ₹1Cr in 15y at 12% = ₹20,017/mo (SEBI convention)", () => {
    const r = calcGoalSip({
      goal: 10_000_000,
      annualReturnPct: 12,
      durationYears: 15,
    });
    assert.ok(
      Math.abs(r.monthlyRequired - 20_017) < 100,
      `expected ~20017 (SEBI), got ${r.monthlyRequired}`,
    );
    // Round-trip: SIP-ing this amount should hit the goal back.
    const back = calcSip({
      monthly: r.monthlyRequired,
      annualReturnPct: 12,
      durationYears: 15,
    });
    assert.ok(
      Math.abs(back.finalValue - 10_000_000) < 1000,
      "round-trip should hit goal",
    );
  });
});

describe("calcInflationAdjustedSip", () => {
  it("12% nominal − 6% inflation ≈ 5.66% real (Fisher)", () => {
    const r = calcInflationAdjustedSip({
      monthly: 10_000,
      nominalReturnPct: 12,
      inflationPct: 6,
      durationYears: 10,
    });
    // Fisher: (1.12 / 1.06) − 1 = 0.0566 = 5.66%
    assert.ok(
      Math.abs(r.realReturnPct - 5.66) < 0.05,
      `real rate ${r.realReturnPct}`,
    );
    assert.ok(
      r.finalValueReal < r.finalValueNominal,
      "real corpus < nominal corpus",
    );
  });
});

describe("calcSwp", () => {
  it("₹50L corpus + ₹30k/mo at 8% lasts > 25 years", () => {
    const r = calcSwp({
      initialCorpus: 5_000_000,
      monthlyWithdrawal: 30_000,
      annualReturnPct: 8,
      durationYears: 30,
    });
    // At ₹30k/mo against ₹50L principal earning 8% the monthly return is
    // ₹33k+ which exceeds the withdrawal - corpus actually grows.
    assert.strictEqual(r.depletedAtMonth, null);
    assert.ok(r.finalBalance > 0, "balance > 0");
    assert.strictEqual(r.monthsLasted, 360);
  });

  it("aggressive withdrawal depletes the corpus", () => {
    const r = calcSwp({
      initialCorpus: 1_000_000,
      monthlyWithdrawal: 50_000,
      annualReturnPct: 6,
      durationYears: 10,
    });
    assert.ok(r.depletedAtMonth != null, "should deplete");
    assert.ok(r.depletedAtMonth! < 120, `depleted at ${r.depletedAtMonth}`);
  });
});

describe("calcXirr", () => {
  it("simple two-flow case: ₹100 in, ₹110 out one year later → ~10%", () => {
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2026-01-01"), amount: 110 },
    ]);
    assert.ok(Math.abs(r - 0.1) < 0.001, `XIRR ${r}`);
  });

  it("Indian-SIP 12-month flow with 12% return ≈ 0.12", () => {
    const flows: { date: Date; amount: number }[] = [];
    for (let i = 0; i < 12; i++) {
      flows.push({
        date: new Date(2025, i, 1),
        amount: -10_000,
      });
    }
    // ~12 months of ₹10k SIP → roughly ₹1.27L FV at 12%
    flows.push({ date: new Date(2026, 0, 1), amount: 127_000 });
    const r = calcXirr(flows);
    assert.ok(Math.abs(r - 0.12) < 0.05, `XIRR ${r}`);
  });

  it("all-positive flows → NaN (no rate satisfies)", () => {
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: 100 },
      { date: new Date("2026-01-01"), amount: 110 },
    ]);
    assert.ok(Number.isNaN(r));
  });
});

describe("calcIncomeTax", () => {
  // This case used to assert ₹1.0–1.3L with the comment "taxable 14.5L (after
  // ₹50k std)" — it encoded the bug as its premise. The new regime's standard
  // deduction has been ₹75,000 since Budget 2024; only the old regime is
  // ₹50,000. A range assertion could absorb the ₹3,900 difference, so this is
  // pinned to the rupee.
  it("FY 25-26 new regime: ₹15L gross = ₹97,500", () => {
    const r = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "25-26",
    });
    // taxable 14.25L after ₹75k std.
    // 0-4L nil; 4-8L 5% = 20,000; 8-12L 10% = 40,000; 12-14.25L 15% = 33,750
    // → 93,750 + 4% cess = 97,500.
    assert.strictEqual(r.taxableIncome, 1_425_000);
    assert.strictEqual(r.totalTax, 97_500);
  });

  it("[regression] ₹12.75L is fully tax-free in the new regime", () => {
    // The Budget 2025 headline, and the tightest possible pin on the ₹75,000
    // figure: it only works as ₹12L rebate threshold + ₹75,000 standard
    // deduction. With the old ₹50,000 this case owes tax, so it fails the
    // moment anyone reverts the constant.
    const r = calcIncomeTax({ income: 1_275_000, regime: "new", fy: "25-26" });
    assert.strictEqual(r.taxableIncome, 1_200_000);
    assert.strictEqual(r.totalTax, 0);
  });

  it("[regression] the standard deduction differs BY REGIME", () => {
    // The shape of the bug: one shared constant for two regimes. Same gross
    // income, and the taxable figures must differ by exactly ₹25,000.
    const nw = calcIncomeTax({ income: 2_000_000, regime: "new", fy: "25-26" });
    const old = calcIncomeTax({
      income: 2_000_000,
      regime: "old",
      fy: "25-26",
    });
    assert.strictEqual(nw.taxableIncome, 1_925_000, "new regime: ₹75k std");
    assert.strictEqual(old.taxableIncome, 1_950_000, "old regime: ₹50k std");
  });

  it("FY 25-26 new regime: ₹12L taxable triggers full 87A rebate ⇒ 0 tax", () => {
    // After ₹75k std (new regime), taxable = ₹11.25L < the ₹12L rebate
    // threshold → 87A wipes the slab tax to 0.
    const r = calcIncomeTax({
      income: 1_200_000,
      regime: "new",
      fy: "25-26",
    });
    assert.strictEqual(r.totalTax, 0);
  });

  it("Old regime: ₹15L gross + ₹2L deductions → higher than new", () => {
    const oldR = calcIncomeTax({
      income: 1_500_000,
      regime: "old",
      deductions: 200_000,
      fy: "25-26",
    });
    const newR = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "25-26",
    });
    // For ₹15L with only ₹2L deductions, new regime is cheaper -
    // confirms the comparison the calculator UI surfaces.
    assert.ok(
      oldR.totalTax > newR.totalTax,
      `old ${oldR.totalTax} should exceed new ${newR.totalTax}`,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEGATIVE + EDGE-CASE coverage (MONEY-620). Each case asserts the CORRECT
// behavior against the REAL exported calc source (imported above — no shadow).
// ───────────────────────────────────────────────────────────────────────────

describe("calcXirr — negative & edge cases", () => {
  it("empty cashflows → NaN (fewer than 2 flows)", () => {
    assert.ok(Number.isNaN(calcXirr([])));
  });

  it("single cashflow → NaN (fewer than 2 flows)", () => {
    assert.ok(
      Number.isNaN(calcXirr([{ date: new Date("2025-01-01"), amount: -100 }])),
    );
  });

  it("all-negative flows → NaN (no rate satisfies)", () => {
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2026-01-01"), amount: -110 },
    ]);
    assert.ok(Number.isNaN(r));
  });

  it("all-zero flows → NaN (neither positive nor negative present)", () => {
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: 0 },
      { date: new Date("2026-01-01"), amount: 0 },
    ]);
    assert.ok(Number.isNaN(r));
  });

  it("sign-flipped multi-flow (−,+,−) still converges to a finite rate", () => {
    const r = calcXirr([
      { date: new Date("2020-01-01"), amount: -1000 },
      { date: new Date("2021-01-01"), amount: 2500 },
      { date: new Date("2022-01-01"), amount: -1000 },
    ]);
    // A genuine root exists for this mixed-sign series; assert it's finite,
    // not NaN, and inside the supported (MIN_RATE, MAX_RATE) band.
    assert.ok(Number.isFinite(r), `expected finite XIRR, got ${r}`);
    assert.ok(r > -0.999 && r < 100, `rate ${r} out of supported band`);
  });

  it("near-total loss (−100 in, +1 out one year) → ≈ −99%", () => {
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2026-01-01"), amount: 1 },
    ]);
    assert.ok(Math.abs(r - -0.99) < 0.001, `XIRR ${r}`);
  });

  it("same-day pos+neg flows → NaN (division by t=0 power yields no root)", () => {
    // days[i] = 0 for all flows ⇒ every term is amount/(1+r)^0 = amount,
    // NPV is a constant ≠ 0, so no rate solves it. Real source returns NaN.
    const r = calcXirr([
      { date: new Date("2025-01-01"), amount: -100 },
      { date: new Date("2025-01-01"), amount: 110 },
    ]);
    assert.ok(Number.isNaN(r));
  });

  it("invalid Date in flows → NaN (NaN getTime() propagates, no crash)", () => {
    const r = calcXirr([
      { date: new Date("not-a-date"), amount: -100 },
      { date: new Date("2026-01-01"), amount: 110 },
    ]);
    assert.ok(Number.isNaN(r));
  });
});

describe("calcIncomeTax — negative & boundary cases", () => {
  it("negative income clamps taxable to 0 ⇒ zero tax (new regime)", () => {
    const r = calcIncomeTax({ income: -500_000, regime: "new", fy: "25-26" });
    assert.strictEqual(r.taxableIncome, 0);
    assert.strictEqual(r.totalTax, 0);
  });

  it("negative income clamps taxable to 0 ⇒ zero tax (old regime)", () => {
    const r = calcIncomeTax({ income: -500_000, regime: "old", fy: "25-26" });
    assert.strictEqual(r.taxableIncome, 0);
    assert.strictEqual(r.totalTax, 0);
  });

  it("zero income ⇒ zero tax", () => {
    const r = calcIncomeTax({ income: 0, regime: "new", fy: "25-26" });
    assert.strictEqual(r.totalTax, 0);
  });

  it(">₹1cr (₹1.5cr) new regime: 15% surcharge band applies", () => {
    const r = calcIncomeTax({ income: 15_000_000, regime: "new", fy: "25-26" });
    // income 1.5cr falls in 1cr–2cr surcharge band (15%).
    assert.ok(
      Math.abs(r.surcharge - r.taxBeforeRebate * 0.15) < 1,
      `surcharge ${r.surcharge} should be 15% of ${r.taxBeforeRebate}`,
    );
    // cess is 4% of (taxAfterRebate + surcharge); no rebate at this income.
    assert.ok(
      Math.abs(r.cess - (r.taxBeforeRebate + r.surcharge) * 0.04) < 1,
      `cess ${r.cess}`,
    );
    assert.ok(r.totalTax > 4_000_000, `total ${r.totalTax}`);
  });

  it("₹6cr new regime: top 37% surcharge band applies", () => {
    const r = calcIncomeTax({ income: 60_000_000, regime: "new", fy: "25-26" });
    assert.ok(
      Math.abs(r.surcharge - r.taxBeforeRebate * 0.37) < 1,
      `surcharge ${r.surcharge} should be 37% of ${r.taxBeforeRebate}`,
    );
  });

  it("boundary: ₹8L gross − ₹50k std = ₹8L taxable, fully rebated ⇒ 0 tax (new)", () => {
    const r = calcIncomeTax({
      income: 850_000,
      regime: "new",
      standardDeduction: 50_000,
      fy: "25-26",
    });
    assert.strictEqual(r.taxableIncome, 800_000);
    assert.strictEqual(r.totalTax, 0); // rebate wipes the ₹20k slab tax
  });

  it("boundary: exactly ₹12L taxable (std 0) → full 87A rebate ⇒ 0 tax (new)", () => {
    const r = calcIncomeTax({
      income: 1_200_000,
      regime: "new",
      standardDeduction: 0,
      fy: "25-26",
    });
    assert.strictEqual(r.taxableIncome, 1_200_000);
    assert.strictEqual(r.totalTax, 0);
  });

  it("boundary: ₹12L + ₹1 taxable → just over rebate ⇒ full slab tax + cess (new)", () => {
    const r = calcIncomeTax({
      income: 1_200_001,
      regime: "new",
      standardDeduction: 0,
      fy: "25-26",
    });
    // One rupee over the ₹12L rebate ceiling: rebate vanishes, the whole
    // ~₹60k slab tax becomes payable + 4% cess. Classic "marginal cliff".
    assert.strictEqual(r.rebate, 0);
    assert.ok(r.totalTax > 60_000, `expected >₹60k, got ${r.totalTax}`);
  });

  it("unknown FY falls back to the 25-26 config (no crash)", () => {
    const fallback = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "99-00",
    });
    const known = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "25-26",
    });
    assert.deepStrictEqual(fallback, known);
  });

  it("negative deductions (old regime) are clamped to 0", () => {
    const neg = calcIncomeTax({
      income: 1_500_000,
      regime: "old",
      deductions: -100_000,
      fy: "25-26",
    });
    const zero = calcIncomeTax({
      income: 1_500_000,
      regime: "old",
      deductions: 0,
      fy: "25-26",
    });
    // Math.max(0, deductions) ⇒ negative deductions must not INCREASE taxable.
    assert.deepStrictEqual(neg, zero);
  });

  // ── Non-finite money inputs must never leak NaN into the result ──────────
  // Regression for the NaN-leak fix in income-tax.ts: a single garbage figure
  // (NaN / ±Infinity income, deductions, or standardDeduction) used to
  // propagate all the way to `totalTax: NaN` — a corrupt tax number rendered
  // straight to the user. Every field of the result must stay finite.

  function assertAllFinite(r: ReturnType<typeof calcIncomeTax>): void {
    for (const [k, v] of Object.entries(r)) {
      assert.ok(Number.isFinite(v), `${k} should be finite, got ${v}`);
    }
  }

  it("NaN income ⇒ all-finite zero result (new regime)", () => {
    const r = calcIncomeTax({ income: NaN, regime: "new", fy: "25-26" });
    assertAllFinite(r);
    assert.strictEqual(r.totalTax, 0);
    assert.strictEqual(r.taxableIncome, 0);
  });

  it("NaN income ⇒ all-finite zero result (old regime)", () => {
    const r = calcIncomeTax({ income: NaN, regime: "old", fy: "25-26" });
    assertAllFinite(r);
    assert.strictEqual(r.totalTax, 0);
  });

  it("+Infinity income ⇒ all-finite zero result (not NaN, not Infinity tax)", () => {
    const r = calcIncomeTax({ income: Infinity, regime: "new", fy: "25-26" });
    assertAllFinite(r);
    assert.strictEqual(r.totalTax, 0);
  });

  it("-Infinity income ⇒ all-finite zero result", () => {
    const r = calcIncomeTax({ income: -Infinity, regime: "new", fy: "25-26" });
    assertAllFinite(r);
    assert.strictEqual(r.totalTax, 0);
  });

  it("NaN deductions (old regime) is treated as 0 (not NaN-poisoned)", () => {
    const nan = calcIncomeTax({
      income: 1_500_000,
      regime: "old",
      deductions: NaN,
      fy: "25-26",
    });
    const zero = calcIncomeTax({
      income: 1_500_000,
      regime: "old",
      deductions: 0,
      fy: "25-26",
    });
    assertAllFinite(nan);
    assert.deepStrictEqual(nan, zero);
  });

  it("NaN standardDeduction falls back to the FY default (not 0, not NaN)", () => {
    const nan = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      standardDeduction: NaN,
      fy: "25-26",
    });
    // Omitting standardDeduction uses the same FY default (₹50k); a non-finite
    // override must resolve identically — it must NOT collapse the deduction to
    // 0 (which would over-tax the user) and must NOT poison the result.
    const omitted = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "25-26",
    });
    assertAllFinite(nan);
    assert.deepStrictEqual(nan, omitted);
  });

  it("Infinity standardDeduction falls back to the FY default", () => {
    const inf = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      standardDeduction: Infinity,
      fy: "25-26",
    });
    const omitted = calcIncomeTax({
      income: 1_500_000,
      regime: "new",
      fy: "25-26",
    });
    assertAllFinite(inf);
    assert.deepStrictEqual(inf, omitted);
  });
});

describe("calcSwp — negative & edge cases", () => {
  it("withdrawal > corpus: depletes in month 1", () => {
    const r = calcSwp({
      initialCorpus: 1_000,
      monthlyWithdrawal: 50_000,
      annualReturnPct: 8,
      durationYears: 5,
    });
    assert.strictEqual(r.depletedAtMonth, 1);
    assert.strictEqual(r.finalBalance, 0);
    assert.strictEqual(r.monthsLasted, 1);
  });

  it("0 corpus → guard returns all-zero result", () => {
    const r = calcSwp({
      initialCorpus: 0,
      monthlyWithdrawal: 5_000,
      annualReturnPct: 8,
      durationYears: 5,
    });
    assert.deepStrictEqual(r, {
      finalBalance: 0,
      totalWithdrawn: 0,
      monthsLasted: 0,
      depletedAtMonth: null,
    });
  });

  it("negative withdrawal → guard (monthlyWithdrawal ≤ 0) returns all-zero", () => {
    const r = calcSwp({
      initialCorpus: 100_000,
      monthlyWithdrawal: -5_000,
      annualReturnPct: 8,
      durationYears: 5,
    });
    assert.strictEqual(r.monthsLasted, 0);
    assert.strictEqual(r.totalWithdrawn, 0);
    assert.strictEqual(r.depletedAtMonth, null);
  });

  it("rate = −100% wipes the balance each month, depleting the corpus early", () => {
    const r = calcSwp({
      initialCorpus: 100_000,
      monthlyWithdrawal: 5_000,
      annualReturnPct: -100,
      durationYears: 5,
    });
    // r = -100/100/12 ⇒ balance *= (1 - 0.0833) each month: it shrinks fast
    // and must deplete well before the 60-month horizon.
    assert.ok(r.depletedAtMonth != null, "should deplete");
    assert.ok(
      r.depletedAtMonth! < 60,
      `should deplete before full term, got ${r.depletedAtMonth}`,
    );
    assert.strictEqual(r.finalBalance, 0);
  });
});

describe("calcNps — negative & edge cases", () => {
  it("negative annuityPct is clamped to 0 (entire corpus → lumpsum, no pension)", () => {
    const r = calcNps({
      monthly: 5_000,
      currentAge: 30,
      retirementAge: 60,
      preReturnPct: 10,
      annuityRatePct: 6,
      annuityPct: -0.5,
    });
    assert.strictEqual(r.annuityCorpus, 0);
    assert.strictEqual(r.monthlyPension, 0);
    assert.ok(Math.abs(r.lumpsum - r.corpus) < 1, "lumpsum = full corpus");
  });

  it("annuityPct > 1 is clamped to 1 (entire corpus → annuity, no lumpsum)", () => {
    const r = calcNps({
      monthly: 5_000,
      currentAge: 30,
      retirementAge: 60,
      preReturnPct: 10,
      annuityRatePct: 6,
      annuityPct: 1.5,
    });
    assert.strictEqual(r.lumpsum, 0);
    assert.ok(
      Math.abs(r.annuityCorpus - r.corpus) < 1,
      "annuityCorpus = full corpus",
    );
    assert.ok(r.monthlyPension > 0);
  });

  it("retirementAge < currentAge → guard returns all-zero", () => {
    const r = calcNps({
      monthly: 5_000,
      currentAge: 60,
      retirementAge: 30,
      preReturnPct: 10,
      annuityRatePct: 6,
      annuityPct: 0.4,
    });
    assert.deepStrictEqual(r, {
      corpus: 0,
      lumpsum: 0,
      annuityCorpus: 0,
      monthlyPension: 0,
    });
  });
});

describe("calcEmi / calcSip / calcLumpsum — negative & zero inputs", () => {
  it("EMI negative principal → guard returns all-zero", () => {
    const r = calcEmi({
      principal: -100_000,
      annualRatePct: 9,
      durationYears: 10,
    });
    assert.deepStrictEqual(r, { emi: 0, totalPayment: 0, totalInterest: 0 });
  });

  it("EMI zero tenure → guard returns all-zero (no division by zero)", () => {
    const r = calcEmi({
      principal: 100_000,
      annualRatePct: 9,
      durationYears: 0,
    });
    assert.deepStrictEqual(r, { emi: 0, totalPayment: 0, totalInterest: 0 });
  });

  it("emiAmortisation with zero tenure → empty schedule (no rows)", () => {
    const rows = emiAmortisation({
      principal: 100_000,
      annualRatePct: 9,
      durationYears: 0,
    });
    assert.strictEqual(rows.length, 0);
  });

  it("SIP negative monthly → guard returns all-zero", () => {
    const r = calcSip({
      monthly: -5_000,
      annualReturnPct: 12,
      durationYears: 5,
    });
    assert.deepStrictEqual(r, {
      invested: 0,
      finalValue: 0,
      gain: 0,
      effectiveCagrPct: 0,
    });
  });

  it("Lumpsum negative principal → guard returns all-zero", () => {
    const r = calcLumpsum({
      principal: -100_000,
      annualReturnPct: 12,
      durationYears: 5,
    });
    assert.deepStrictEqual(r, {
      invested: 0,
      finalValue: 0,
      gain: 0,
      cagrPct: 0,
    });
  });

  it("Lumpsum rate = −100% → final value is 0 (total wipeout)", () => {
    const r = calcLumpsum({
      principal: 100_000,
      annualReturnPct: -100,
      durationYears: 5,
    });
    assert.strictEqual(r.finalValue, 0);
    assert.strictEqual(r.gain, -100_000);
  });
});

describe("calcStepUpSip / calcFd / calcRd / calcGoalSip — guards", () => {
  it("StepUp negative monthly → all-zero", () => {
    const r = calcStepUpSip({
      monthly: -5_000,
      annualReturnPct: 12,
      durationYears: 5,
      stepUpPct: 10,
    });
    assert.deepStrictEqual(r, { invested: 0, finalValue: 0, gain: 0 });
  });

  it("FD zero principal → all-zero", () => {
    const r = calcFd({
      principal: 0,
      annualRatePct: 7,
      durationYears: 5,
      compounding: "quarterly",
    });
    assert.deepStrictEqual(r, {
      invested: 0,
      maturity: 0,
      interest: 0,
      effectiveYieldPct: 0,
    });
  });

  it("RD negative monthly → all-zero", () => {
    const r = calcRd({ monthly: -5_000, annualRatePct: 6.5, durationYears: 5 });
    assert.deepStrictEqual(r, { invested: 0, maturity: 0, interest: 0 });
  });

  it("GoalSip zero goal → all-zero (no division)", () => {
    const r = calcGoalSip({ goal: 0, annualReturnPct: 12, durationYears: 15 });
    assert.deepStrictEqual(r, {
      monthlyRequired: 0,
      totalInvested: 0,
      futureValue: 0,
    });
  });

  it("GoalSip zero rate → linear monthly = goal / months", () => {
    const r = calcGoalSip({
      goal: 1_200_000,
      annualReturnPct: 0,
      durationYears: 10,
    });
    // 120 months, zero return ⇒ ₹10,000/mo.
    assert.strictEqual(r.monthlyRequired, 10_000);
  });
});

describe("calcInflationAdjustedSip — edge cases", () => {
  it("zero monthly → invested & both corpora are 0", () => {
    const r = calcInflationAdjustedSip({
      monthly: 0,
      nominalReturnPct: 12,
      inflationPct: 6,
      durationYears: 10,
    });
    assert.strictEqual(r.invested, 0);
    assert.strictEqual(r.finalValueNominal, 0);
    assert.strictEqual(r.finalValueReal, 0);
  });

  it("inflation > nominal → negative real rate, real corpus < invested", () => {
    const r = calcInflationAdjustedSip({
      monthly: 10_000,
      nominalReturnPct: 4,
      inflationPct: 10,
      durationYears: 10,
    });
    assert.ok(
      r.realReturnPct < 0,
      `real rate ${r.realReturnPct} should be negative`,
    );
    assert.ok(
      r.finalValueReal < r.finalValueNominal,
      "real corpus erodes below nominal",
    );
  });
});

describe("calcCagr — null-returning edge cases (honest '—', never fabricated)", () => {
  it("startValue ≤ 0 → null", () => {
    assert.strictEqual(calcCagr(0, 200, 5), null);
    assert.strictEqual(calcCagr(-100, 200, 5), null);
  });

  it("endValue < 0 → null", () => {
    assert.strictEqual(calcCagr(100, -50, 5), null);
  });

  it("years ≤ 0 → null", () => {
    assert.strictEqual(calcCagr(100, 200, 0), null);
    assert.strictEqual(calcCagr(100, 200, -3), null);
  });

  it("non-finite inputs → null", () => {
    assert.strictEqual(calcCagr(NaN, 200, 5), null);
    assert.strictEqual(calcCagr(100, Infinity, 5), null);
    assert.strictEqual(calcCagr(100, 200, NaN), null);
  });

  it("valid doubling over 1 year → 1.0 (100% CAGR)", () => {
    const r = calcCagr(100, 200, 1);
    assert.ok(r != null && Math.abs(r - 1) < 1e-9, `got ${r}`);
  });
});
