/**
 * Goal SIP - back-solve the monthly contribution required to reach a
 * target corpus given an annual return and duration.
 *
 * Rearrange the SIP FV formula:
 *
 *   FV = P × ((1+r)^n − 1) / r
 *   ⇒ P = FV / [((1+r)^n − 1) / r]
 *
 * Ordinary annuity, matching calcSip. These two MUST use the same convention:
 * this is literally the rearrangement of that formula, so a mismatch would mean
 * `calcGoalSip` returns a contribution that `calcSip` then values at something
 * other than the goal.
 *
 * with r = monthly rate, n = total months.
 *
 * Ordinary-annuity (end-of-month) timing, matching `calcSip` — see the note
 * there (MONEY-1162). Because this back-solves the same formula, the two must
 * always use the same convention: with annuity-due here and ordinary annuity
 * in calcSip, investing the returned `monthlyRequired` would undershoot the
 * goal by roughly one month's return.
 */

export interface GoalSipInput {
  /** Target corpus to reach. */
  goal: number;
  annualReturnPct: number;
  durationYears: number;
}

export interface GoalSipResult {
  monthlyRequired: number;
  totalInvested: number;
  futureValue: number;
}

export function calcGoalSip(input: GoalSipInput): GoalSipResult {
  const { goal, annualReturnPct, durationYears } = input;
  if (goal <= 0 || durationYears <= 0) {
    return { monthlyRequired: 0, totalInvested: 0, futureValue: 0 };
  }
  const months = Math.round(durationYears * 12);
  const r = annualReturnPct / 100 / 12;

  let monthly: number;
  if (r === 0) {
    monthly = goal / months;
  } else {
    const factor = (Math.pow(1 + r, months) - 1) / r;
    monthly = goal / factor;
  }
  return {
    monthlyRequired: r2(monthly),
    totalInvested: r2(monthly * months),
    futureValue: r2(goal),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
