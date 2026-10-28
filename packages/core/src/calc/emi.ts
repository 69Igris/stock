/**
 * EMI - fixed monthly payment for a loan + amortisation schedule.
 *
 *   EMI = P × r × (1 + r)^n / ((1 + r)^n − 1)
 *
 * P = loan principal
 * r = monthly rate = annualRate / 12
 * n = total months
 *
 * Standard reducing-balance interest pattern (matches every Indian
 * home/car loan calculator).
 */

export interface EmiInput {
  principal: number;
  annualRatePct: number;
  durationYears: number;
}

export interface EmiResult {
  emi: number;
  totalPayment: number;
  totalInterest: number;
}

export function calcEmi(input: EmiInput): EmiResult {
  const { principal, annualRatePct, durationYears } = input;
  if (principal <= 0 || durationYears <= 0) {
    return { emi: 0, totalPayment: 0, totalInterest: 0 };
  }
  const months = Math.round(durationYears * 12);
  const r = annualRatePct / 100 / 12;

  let emi: number;
  if (r === 0) {
    emi = principal / months;
  } else {
    const factor = Math.pow(1 + r, months);
    emi = (principal * r * factor) / (factor - 1);
  }
  const totalPayment = emi * months;
  return {
    emi: r2(emi),
    totalPayment: r2(totalPayment),
    totalInterest: r2(totalPayment - principal),
  };
}

export interface EmiAmortisationRow {
  monthIdx: number;
  emi: number;
  interestPart: number;
  principalPart: number;
  remainingBalance: number;
}

/** Optional amortisation schedule - handy for a per-month chart. */
export function emiAmortisation(input: EmiInput): EmiAmortisationRow[] {
  const { principal, annualRatePct, durationYears } = input;
  const months = Math.round(durationYears * 12);
  const r = annualRatePct / 100 / 12;
  const { emi } = calcEmi(input);

  const rows: EmiAmortisationRow[] = [];
  let balance = principal;
  for (let i = 1; i <= months; i++) {
    const interestPart = balance * r;
    const principalPart = emi - interestPart;
    balance = Math.max(0, balance - principalPart);
    rows.push({
      monthIdx: i,
      emi: r2(emi),
      interestPart: r2(interestPart),
      principalPart: r2(principalPart),
      remainingBalance: r2(balance),
    });
  }
  return rows;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
