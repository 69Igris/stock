/**
 * Lumpsum - one-time investment + assumed annual return, compounded
 * annually.
 *
 *   FV = P × (1 + r)^n
 *
 * where P is principal, r is annual rate, n is years.
 */

export interface LumpsumInput {
  principal: number;
  annualReturnPct: number;
  durationYears: number;
}

export interface LumpsumResult {
  invested: number;
  finalValue: number;
  gain: number;
  cagrPct: number;
}

export function calcLumpsum(input: LumpsumInput): LumpsumResult {
  const { principal, annualReturnPct, durationYears } = input;
  if (principal <= 0 || durationYears <= 0) {
    return { invested: 0, finalValue: 0, gain: 0, cagrPct: 0 };
  }
  const r = annualReturnPct / 100;
  const finalValue = principal * Math.pow(1 + r, durationYears);
  return {
    invested: r2(principal),
    finalValue: r2(finalValue),
    gain: r2(finalValue - principal),
    cagrPct: r2(annualReturnPct),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
