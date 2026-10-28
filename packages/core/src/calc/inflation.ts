/**
 * Inflation-adjusted SIP - same calculation as plain SIP but using
 * the *real* return rate (nominal − inflation, Fisher equation).
 *
 *   realRate = (1 + nominal) / (1 + inflation) − 1
 *
 * Plus a forecast of the corpus's purchasing power in today's rupees.
 */

import { calcSip } from "./sip";

export interface InflationSipInput {
  monthly: number;
  /** Nominal annual return (as percentage). */
  nominalReturnPct: number;
  /** Annual inflation rate (as percentage). */
  inflationPct: number;
  durationYears: number;
}

export interface InflationSipResult {
  invested: number;
  /** Final corpus in nominal rupees. */
  finalValueNominal: number;
  /** Final corpus in today's rupees (purchasing power). */
  finalValueReal: number;
  realReturnPct: number;
}

export function calcInflationAdjustedSip(
  input: InflationSipInput,
): InflationSipResult {
  const { monthly, nominalReturnPct, inflationPct, durationYears } = input;
  const realRate =
    ((1 + nominalReturnPct / 100) / (1 + inflationPct / 100) - 1) * 100;

  const nominal = calcSip({
    monthly,
    annualReturnPct: nominalReturnPct,
    durationYears,
  });
  const realValue =
    nominal.finalValue / Math.pow(1 + inflationPct / 100, durationYears);

  return {
    invested: nominal.invested,
    finalValueNominal: nominal.finalValue,
    finalValueReal: r2(realValue),
    realReturnPct: r2(realRate),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
