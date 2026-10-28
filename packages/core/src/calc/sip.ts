/**
 * SIP - fixed monthly contribution + assumed annual return.
 *
 * Future value formula (END-of-period contribution — an ordinary annuity):
 *   FV = P × [((1 + r)^n − 1) / r]
 *
 * This matches SEBI's official investor SIP calculator, which is the reference
 * an Indian retail investor will check the number against. For ₹5,000/month at
 * 12% for 10 years it gives ₹11,50,193.
 *
 * It previously carried a trailing `× (1 + r)` — annuity-DUE, contribution at
 * the START of each month, which earns one extra month of return on every
 * instalment and reported ₹11,61,695 for the same inputs. ₹11,502 too high on a
 * ₹6,00,000 investment, and the gap widens with duration.
 *
 * The doc comment above that formula already said "end-of-period contribution"
 * while the code did the opposite, so the intent was recorded correctly and the
 * implementation simply did not match it.
 *
 * where:
 *   P = monthly contribution (₹)
 *   r = monthly rate = annualRate / 12
 *   n = total months
 *
 * End-of-month timing matches SEBI's investor calculator — the reference
 * Indian retail users check their numbers against (MONEY-1162). The previous
 * form carried a trailing × (1 + r) (annuity-due), granting every instalment
 * one extra month of growth and reading ~1% high: ₹4,12,432 against SEBI's
 * ₹4,08,348 for ₹5,000/mo at 12% over 5 years. Note that the comment above
 * already claimed end-of-period timing; only the formula disagreed.
 *
 * This is THE SIP primitive for the whole product — `calcStepUpSip`,
 * `calcGoalSip`, `calcNps`, the inflation-adjusted calculator and the MF/ETF
 * fund-detail widgets (via apps/web/components/mf/sip-math.ts) all resolve
 * here, so the convention is defined in exactly one place.
 *
 * Returns invested + final + gain + CAGR-equivalent.
 */

export interface SipInput {
  monthly: number;
  annualReturnPct: number;
  durationYears: number;
}

export interface SipResult {
  invested: number;
  finalValue: number;
  gain: number;
  /** Annualised return - same as input when no edge cases. */
  effectiveCagrPct: number;
}

export function calcSip(input: SipInput): SipResult {
  const { monthly, annualReturnPct, durationYears } = input;
  if (monthly <= 0 || durationYears <= 0) {
    return { invested: 0, finalValue: 0, gain: 0, effectiveCagrPct: 0 };
  }
  const months = Math.round(durationYears * 12);
  const r = annualReturnPct / 100 / 12;
  const invested = monthly * months;

  let finalValue: number;
  if (r === 0) {
    finalValue = invested;
  } else {
    finalValue = monthly * ((Math.pow(1 + r, months) - 1) / r);
  }

  return {
    invested: round2(invested),
    finalValue: round2(finalValue),
    gain: round2(finalValue - invested),
    effectiveCagrPct: round2(annualReturnPct),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
