/**
 * Step-up SIP - monthly contribution increases by a fixed percentage
 * each year. Common Indian retail pattern: ₹10k/mo with 10% annual
 * step-up tracks salary growth.
 *
 * Year-by-year FV at the end of each year then compounds the carrying
 * balance forward at the same monthly rate. Closed-form is messy with
 * step-up so we just iterate - durations are bounded (< 50y) and
 * iteration is cheap.
 */

export interface StepUpSipInput {
  /** Starting monthly amount (will increase year-over-year). */
  monthly: number;
  annualReturnPct: number;
  durationYears: number;
  /** Annual step-up percentage applied at the start of each year. */
  stepUpPct: number;
}

export interface StepUpSipResult {
  invested: number;
  finalValue: number;
  gain: number;
}

export function calcStepUpSip(input: StepUpSipInput): StepUpSipResult {
  const { monthly, annualReturnPct, durationYears, stepUpPct } = input;
  if (monthly <= 0 || durationYears <= 0) {
    return { invested: 0, finalValue: 0, gain: 0 };
  }
  const monthlyRate = annualReturnPct / 100 / 12;
  const stepUp = stepUpPct / 100;

  let balance = 0;
  let invested = 0;
  let currentMonthly = monthly;

  for (let year = 0; year < durationYears; year++) {
    for (let m = 0; m < 12; m++) {
      // Ordinary-annuity timing - earn the month's return on the existing
      // balance, THEN contribute. The instalment does not earn return in the
      // month it is paid. Matches calcSip (and SEBI's calculator), so a 0%
      // step-up round-trips back to plain SIP exactly — asserted in the suite.
      balance = balance * (1 + monthlyRate) + currentMonthly;
      invested += currentMonthly;
    }
    // Year-end step-up applies to next year's contributions.
    currentMonthly = currentMonthly * (1 + stepUp);
  }

  return {
    invested: r2(invested),
    finalValue: r2(balance),
    gain: r2(balance - invested),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
