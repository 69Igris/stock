/**
 * SWP - systematic withdrawal plan. Given a starting corpus, fixed
 * monthly withdrawal, and assumed return, project month-by-month
 * until either:
 *   - the planned duration completes, or
 *   - the balance hits zero (corpus depleted)
 *
 * Returns the final balance, total withdrawn, and the month-of-depletion
 * (null if corpus survives the full duration).
 */

export interface SwpInput {
  initialCorpus: number;
  monthlyWithdrawal: number;
  annualReturnPct: number;
  durationYears: number;
}

export interface SwpResult {
  finalBalance: number;
  totalWithdrawn: number;
  monthsLasted: number;
  /** Null if corpus survived the full duration; else month index of depletion. */
  depletedAtMonth: number | null;
}

export function calcSwp(input: SwpInput): SwpResult {
  const { initialCorpus, monthlyWithdrawal, annualReturnPct, durationYears } =
    input;
  if (initialCorpus <= 0 || monthlyWithdrawal <= 0 || durationYears <= 0) {
    return {
      finalBalance: 0,
      totalWithdrawn: 0,
      monthsLasted: 0,
      depletedAtMonth: null,
    };
  }
  const months = Math.round(durationYears * 12);
  const r = annualReturnPct / 100 / 12;

  let balance = initialCorpus;
  let withdrawn = 0;
  let depletedAt: number | null = null;
  let monthsLasted = 0;

  for (let i = 1; i <= months; i++) {
    // Earn one month of return THEN withdraw - banks/fund houses usually
    // post NAV changes first, then process the SWP redemption.
    balance = balance * (1 + r);
    if (balance < monthlyWithdrawal) {
      // Final partial withdrawal - what's left
      withdrawn += balance;
      monthsLasted = i;
      balance = 0;
      depletedAt = i;
      break;
    }
    balance -= monthlyWithdrawal;
    withdrawn += monthlyWithdrawal;
    monthsLasted = i;
  }

  return {
    finalBalance: r2(balance),
    totalWithdrawn: r2(withdrawn),
    monthsLasted,
    depletedAtMonth: depletedAt,
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
