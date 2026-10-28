import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
  ProjectionData,
} from "./types";

export function computeWeightedReturn(assetClasses: AssetClass[]): number {
  const totalAllocation = assetClasses.reduce(
    (sum, ac) => sum + ac.allocation,
    0,
  );
  if (totalAllocation === 0) return 10;
  return assetClasses.reduce(
    (sum, ac) => sum + (ac.allocation / totalAllocation) * ac.expectedReturn,
    0,
  );
}

export function computeAvgInflation(expenses: MonthlyExpense[]): number {
  const totalAmount = expenses.reduce((sum, e) => sum + e.amount, 0);
  if (totalAmount === 0) return 6;
  return expenses.reduce(
    (sum, e) => sum + (e.inflation * e.amount) / totalAmount,
    0,
  );
}

/**
 * Effective return after tax. The corpus earns `weightedReturn` gross, but
 * realised gains are taxed, so the rate available to fund retirement spending
 * (and therefore the rate we discount future expenses at) is post-tax.
 *
 * All rates are percentages (e.g. 10.4, not 0.104).
 */
export function computePostTaxReturn(
  weightedReturn: number,
  taxRate: number,
): number {
  return weightedReturn * (1 - taxRate / 100);
}

/**
 * The year a one-time expense falls due, snapped to the whole-year grid the
 * projections advance on.
 *
 * The goals table takes `yearsAway` from an unconstrained numeric input, so a
 * value like 18.5 is reachable. Every schedule check below is an equality
 * against an integer loop index, and 18.5 never equals one — so before
 * MONEY-1161 a fractional goal silently vanished from the accumulation
 * deduction, the drawdown withdrawal and the projection chart alike, taking its
 * entire cost out of the plan.
 *
 * Cost inflation is raised to this same snapped exponent so the amount and its
 * timing stay consistent. Integer `yearsAway` — every value the UI produces
 * today — is unaffected.
 *
 * Exported so the goals table can show the same future cost the plan actually
 * uses, rather than keeping its own copy of the rounding rule.
 */
export function dueYear(expense: OneTimeExpense): number {
  return Math.max(0, Math.round(expense.yearsAway));
}

/**
 * Present value, AT RETIREMENT, of every one-time expense that falls on or
 * after the retirement date. Each expense is inflated (at its own rate) to the
 * year it occurs, then discounted back to retirement at the post-tax return.
 */
export function computeOneTimeExpensesForFire(
  oneTimeExpenses: OneTimeExpense[],
  retirementAge: number,
  currentAge: number,
  weightedReturn: number,
  taxRate: number,
): number {
  const yearsFromNow = retirementAge - currentAge;
  const postTaxReturn = computePostTaxReturn(weightedReturn, taxRate);
  let total = 0;

  oneTimeExpenses.forEach((expense) => {
    const due = dueYear(expense);
    if (due >= yearsFromNow) {
      const inflatedAtExpense =
        expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
      const yearsAfterRetirement = due - yearsFromNow;
      total +=
        inflatedAtExpense /
        Math.pow(1 + postTaxReturn / 100, yearsAfterRetirement);
    }
  });

  return total;
}

/**
 * FIRE number = the corpus required AT RETIREMENT to fund all future spending
 * to life expectancy, after which it is fully depleted.
 *
 * Recurring spending is a growing-annuity present value: each retirement year's
 * inflated annual expense, discounted back to retirement at the post-tax
 * return. One-time expenses are added as their own present value.
 *
 * This replaces the old safe-withdrawal-rate (perpetuity) model.
 */
export function computeFireNumber(
  totalMonthlyExpenses: number,
  avgInflation: number,
  weightedReturn: number,
  taxRate: number,
  retirementAge: number,
  currentAge: number,
  lifeExpectancy: number,
  oneTimeExpensesForFire: number,
): number {
  const yearsToRetire = retirementAge - currentAge;
  const retirementYears = Math.max(0, lifeExpectancy - retirementAge);
  const inflation = avgInflation / 100;
  const postTaxReturn = computePostTaxReturn(weightedReturn, taxRate) / 100;

  let recurringPv = 0;
  for (let t = 0; t < retirementYears; t++) {
    // Expense in retirement year t, inflated from today's price (annuity-due:
    // the year-t payment is discounted by t, so the first is not discounted).
    const annualExpense =
      totalMonthlyExpenses * 12 * Math.pow(1 + inflation, yearsToRetire + t);
    recurringPv += annualExpense / Math.pow(1 + postTaxReturn, t);
  }

  return recurringPv + oneTimeExpensesForFire;
}

/**
 * Safe-withdrawal-rate FIRE number (perpetual corpus) — the classic "4% rule".
 * The corpus is sized so that withdrawing `withdrawalRate`% of it covers the
 * first retirement year's (inflated) expenses, and — assuming real returns
 * hold — never runs out. Shown alongside computeFireNumber so the user can
 * compare "fund to life expectancy" against "fund forever".
 *
 * Tax is intentionally ignored (SWR is a gross-return rule of thumb). One-time
 * expenses reuse the same present value as the depletion number.
 */
export function computeSwrFireNumber(
  totalMonthlyExpenses: number,
  avgInflation: number,
  withdrawalRate: number,
  retirementAge: number,
  currentAge: number,
  oneTimeExpensesForFire: number,
): number {
  const yearsToRetire = retirementAge - currentAge;
  const inflatedAnnualExpenses =
    totalMonthlyExpenses * 12 * Math.pow(1 + avgInflation / 100, yearsToRetire);
  const base =
    withdrawalRate > 0 ? inflatedAnnualExpenses / (withdrawalRate / 100) : 0;
  return base + oneTimeExpensesForFire;
}

export function computeYearsToFire(
  currentCorpus: number,
  monthlySavings: number,
  fireNumber: number,
  weightedReturn: number,
  savingsIncrement: number,
  retirementAge: number,
  currentAge: number,
  totalMonthlyExpenses: number,
  avgInflation: number,
  taxRate: number,
  withdrawalRate: number,
  oneTimeExpenses: OneTimeExpense[],
): number {
  const targetCorpus = fireNumber;
  let corpus = currentCorpus;
  let years = 0;
  const maxYears = 100;
  let currentMonthlySavings = monthlySavings;
  const postTaxReturn = computePostTaxReturn(weightedReturn, taxRate);
  const yearsToRetire = retirementAge - currentAge;

  const paidExpenses = new Set<string>();

  /**
   * A goal falling due BEFORE retirement is paid out of the accumulating
   * corpus, and is deliberately excluded from `fireNumber` (which sizes the
   * corpus needed AT retirement). So crossing the target early does not mean
   * the plan is funded — an unpaid liability is still coming.
   *
   * The old `while (corpus < targetCorpus)` header stopped the simulation at
   * the first crossing, which meant any goal scheduled after that point was
   * never deducted at all: its cost had no effect on anything (MONEY-1161).
   */
  const hasUnpaidPreRetirementGoal = () =>
    oneTimeExpenses.some(
      (expense) =>
        !paidExpenses.has(expense.id) && dueYear(expense) < yearsToRetire,
    );

  // First crossing that survives every pre-retirement goal; -1 while unfunded.
  let fireYear = -1;

  while (years < maxYears) {
    if (corpus >= targetCorpus) {
      if (fireYear === -1) fireYear = years;
      // Funded AND nothing left to pay before retirement — the date holds.
      if (!hasUnpaidPreRetirementGoal()) break;
    } else {
      // Either not there yet, or paying a goal knocked the corpus back under
      // the target: the FIRE date moves out to the next crossing.
      fireYear = -1;
    }

    const age = currentAge + years;

    if (age < retirementAge) {
      // Accumulation: corpus compounds at the gross (pre-tax) return.
      corpus = corpus * (1 + weightedReturn / 100) + currentMonthlySavings * 12;

      oneTimeExpenses.forEach((expense) => {
        const due = dueYear(expense);
        if (due === years && !paidExpenses.has(expense.id)) {
          const inflatedCost =
            expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
          corpus -= inflatedCost;
          paidExpenses.add(expense.id);
        }
      });

      if (age + 1 < retirementAge) {
        currentMonthlySavings =
          currentMonthlySavings * (1 + savingsIncrement / 100);
      }
    } else {
      // Drawdown: that year's spending is withdrawn first (annuity-due, to
      // match computeFireNumber), then the remainder compounds post-tax.
      const yearlyExpense =
        totalMonthlyExpenses * 12 * Math.pow(1 + avgInflation / 100, years);

      let oneTimeThisYear = 0;
      oneTimeExpenses.forEach((expense) => {
        const due = dueYear(expense);
        if (due === years && !paidExpenses.has(expense.id)) {
          oneTimeThisYear +=
            expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
          paidExpenses.add(expense.id);
        }
      });

      // Withdrawal-rate cap: never pull more than withdrawalRate% of the corpus.
      const desired = yearlyExpense + oneTimeThisYear;
      const cap = corpus * (withdrawalRate / 100);
      const withdrawal = Math.min(desired, cap);
      corpus = (corpus - withdrawal) * (1 + postTaxReturn / 100);
    }

    years++;
  }

  return fireYear === -1 ? 999 : fireYear;
}

export function computeProjectionData(
  currentAge: number,
  retirementAge: number,
  currentCorpus: number,
  monthlySavings: number,
  totalMonthlyExpenses: number,
  avgInflation: number,
  weightedReturn: number,
  taxRate: number,
  withdrawalRate: number,
  lifeExpectancy: number,
  yearsToFire: number,
  savingsIncrement: number,
  oneTimeExpenses: OneTimeExpense[],
): ProjectionData[] {
  const data: ProjectionData[] = [];
  let corpus = currentCorpus;
  let currentSavings = monthlySavings;
  // Cover the whole lifespan (age → life expectancy), not just 40 years — a
  // young current age with a distant life expectancy would otherwise truncate
  // the curve mid-drawdown.
  const maxYears = Math.max(40, yearsToFire + 10, lifeExpectancy - currentAge);
  const paidExpenses = new Set<string>();
  const inflation = avgInflation / 100;
  const postTaxReturn = computePostTaxReturn(weightedReturn, taxRate);
  const postTaxRate = postTaxReturn / 100;

  for (let year = 0; year <= maxYears; year++) {
    const age = currentAge + year;
    const yearsFromNow = year;

    // FIRE target AT THIS AGE: present value of the remaining recurring
    // spending (this age → life expectancy) plus remaining one-time expenses,
    // discounted at the post-tax return. Mirrors computeFireNumber so the
    // target line meets the headline number at the retirement age.
    const yearsLeft = Math.max(0, lifeExpectancy - age);
    let baseFireNumAtThisAge = 0;
    for (let t = 0; t < yearsLeft; t++) {
      const annualExpense =
        totalMonthlyExpenses * 12 * Math.pow(1 + inflation, yearsFromNow + t);
      baseFireNumAtThisAge += annualExpense / Math.pow(1 + postTaxRate, t);
    }

    let oneTimeExpensesAtThisAge = 0;
    oneTimeExpenses.forEach((expense) => {
      const due = dueYear(expense);
      if (due >= yearsFromNow && !paidExpenses.has(expense.id)) {
        const inflatedCostAtExpense =
          expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
        const yearsAfterThisAge = due - yearsFromNow;
        oneTimeExpensesAtThisAge +=
          inflatedCostAtExpense / Math.pow(1 + postTaxRate, yearsAfterThisAge);
      }
    });

    const totalFireNumber = baseFireNumAtThisAge + oneTimeExpensesAtThisAge;

    // Compute this year's retirement drawdown up front so any unfunded
    // shortfall (when the withdrawal-rate cap bites) is recorded on this row.
    let shortfall = 0;
    let drawdownWithdrawal = 0;
    // Spending happens in retirement years up to (but not including) the death
    // year — computeFireNumber funds ages retire..life-1, so the life row is a
    // no-spend endpoint.
    if (age >= retirementAge && age < lifeExpectancy) {
      const yearlyExpense =
        totalMonthlyExpenses * 12 * Math.pow(1 + inflation, year);

      // Post-retirement one-time expenses fall due this year too.
      let oneTimeThisYear = 0;
      oneTimeExpenses.forEach((expense) => {
        const due = dueYear(expense);
        if (due === year && !paidExpenses.has(expense.id)) {
          oneTimeThisYear +=
            expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
          paidExpenses.add(expense.id);
        }
      });

      // Withdrawal-rate cap: never pull more than withdrawalRate% of the
      // current corpus. Anything desired beyond the cap is an unfunded
      // shortfall (the plan is unsustainable that year).
      const desired = yearlyExpense + oneTimeThisYear;
      const cap = corpus * (withdrawalRate / 100);
      drawdownWithdrawal = Math.min(desired, cap);
      shortfall = Math.max(0, desired - drawdownWithdrawal);
    }

    data.push({
      year: new Date().getFullYear() + year,
      age,
      corpus: Math.round(corpus),
      fireNumber: Math.round(totalFireNumber),
      savings: Math.round(currentSavings * 12),
      expenses: Math.round(
        totalMonthlyExpenses * 12 * Math.pow(1 + inflation, year),
      ),
      shortfall: Math.round(shortfall),
    });

    if (age < retirementAge) {
      // Accumulation: gross (pre-tax) compounding plus savings.
      corpus = corpus * (1 + weightedReturn / 100) + currentSavings * 12;

      oneTimeExpenses.forEach((expense) => {
        const due = dueYear(expense);
        if (due === year && !paidExpenses.has(expense.id)) {
          const inflatedCost =
            expense.currentCost * Math.pow(1 + expense.inflation / 100, due);
          corpus -= inflatedCost;
          paidExpenses.add(expense.id);
        }
      });

      if (age + 1 < retirementAge) {
        currentSavings = currentSavings * (1 + savingsIncrement / 100);
      }
    } else {
      // Drawdown: withdraw the (capped) amount computed above, then the
      // remainder compounds post-tax.
      corpus = (corpus - drawdownWithdrawal) * (1 + postTaxRate);
    }

    corpus = Math.max(0, corpus);
    if (age >= lifeExpectancy) break;
  }

  return data;
}

/**
 * Inverse of the recurring part of computeFireNumber: given the corpus actually
 * available at retirement, the spending it can sustain — growing with inflation
 * and fully depleting by life expectancy — expressed as a monthly figure in
 * at-retirement rupees. Replaces the old fixed 4%-rule estimate.
 */
export function computeSustainableMonthly(
  corpusAtRetire: number,
  avgInflation: number,
  weightedReturn: number,
  taxRate: number,
  retirementAge: number,
  lifeExpectancy: number,
): number {
  const retirementYears = Math.max(0, lifeExpectancy - retirementAge);
  if (retirementYears === 0) return 0;
  const inflation = avgInflation / 100;
  const postTaxReturn = computePostTaxReturn(weightedReturn, taxRate) / 100;

  let factor = 0;
  for (let t = 0; t < retirementYears; t++) {
    factor += Math.pow(1 + inflation, t) / Math.pow(1 + postTaxReturn, t);
  }
  if (factor === 0) return 0;

  const sustainableAnnualAtRetire = corpusAtRetire / factor;
  return sustainableAnnualAtRetire / 12;
}

export function computeFireStatus(
  yearsToFire: number,
  retirementAge: number,
  currentAge: number,
): { status: string; message: string; color: string } {
  const targetYears = retirementAge - currentAge;
  if (yearsToFire <= targetYears) {
    return {
      status: "on-track",
      message: `You can retire by age ${currentAge + yearsToFire}!`,
      color: "text-emerald-500",
    };
  } else if (yearsToFire < targetYears + 5) {
    return {
      status: "close",
      message: `You're ${yearsToFire - targetYears} years behind target`,
      color: "text-yellow-500",
    };
  } else if (yearsToFire >= 999) {
    return {
      status: "off-track",
      message: "Increase savings to reach FIRE",
      color: "text-red-500",
    };
  } else {
    return {
      status: "off-track",
      message: `${yearsToFire - targetYears} years behind target`,
      color: "text-red-500",
    };
  }
}
