/**
 * RD - recurring deposit. A fixed monthly instalment earning bank-style
 * QUARTERLY compounding (post-office / SBI / HDFC RD products).
 *
 * Standard Indian RD maturity formula:
 *
 *   M = R × [(1 + i)^n − 1] / [1 − (1 + i)^(−1/3)]
 *
 *   R = monthly instalment
 *   i = quarterly rate = annualRate / 4
 *   n = number of quarters = months / 3
 *
 * The `(1 + i)^(−1/3)` term is the whole subtlety: instalments are paid
 * MONTHLY while interest compounds QUARTERLY, so each one earns for the months
 * it is actually on deposit, not for the whole quarter it happens to fall in.
 *
 * This previously ran a month-by-month loop that did `balance += monthly` and
 * THEN compounded on every third month. That credited a full quarter's interest
 * to an instalment paid the same day it compounded — the month-3 deposit earned
 * a full quarter having been held for zero days. On ₹5,000/month for 5y at 7%
 * it over-reported maturity by ₹2,082 (₹3,61,746 against the correct
 * ₹3,59,664), i.e. 3.5% too much interest, and the error grows with duration.
 *
 * Same defect class as the SIP annuity-timing bug: a contribution credited one
 * period earlier than it is actually made.
 *
 * Rate basis is NOMINAL (annualRate / 4), matching how Indian banks quote RD
 * rates and consistent with calcSip (R/12) and calcEmi (R/12) in this package.
 */

export interface RdInput {
  monthly: number;
  annualRatePct: number;
  durationYears: number;
}

export interface RdResult {
  invested: number;
  maturity: number;
  interest: number;
}

export function calcRd(input: RdInput): RdResult {
  const { monthly, annualRatePct, durationYears } = input;
  if (monthly <= 0 || durationYears <= 0) {
    return { invested: 0, maturity: 0, interest: 0 };
  }
  const months = Math.round(durationYears * 12);
  const invested = monthly * months;
  const i = annualRatePct / 100 / 4;

  // A zero rate has no maturity gain, and the formula below divides by
  // `1 - (1+i)^(-1/3)`, which is 0 when i is 0.
  if (i === 0) {
    return { invested: r2(invested), maturity: r2(invested), interest: 0 };
  }

  // Fractional quarters fall out naturally — a 5-month RD is n = 5/3.
  const n = months / 3;
  const maturity =
    (monthly * (Math.pow(1 + i, n) - 1)) / (1 - Math.pow(1 + i, -1 / 3));

  return {
    invested: r2(invested),
    maturity: r2(maturity),
    interest: r2(maturity - invested),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
