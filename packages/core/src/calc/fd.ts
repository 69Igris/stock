/**
 * FD - fixed deposit, principal compounded at a configurable frequency
 * (monthly / quarterly / half-yearly / yearly).
 *
 *   FV = P × (1 + r/n)^(n × t)
 *
 * P = principal, r = annualRate, n = compounds per year, t = years.
 */

export type FdCompounding = "monthly" | "quarterly" | "half-yearly" | "yearly";

const FREQ_PER_YEAR: Record<FdCompounding, number> = {
  monthly: 12,
  quarterly: 4,
  "half-yearly": 2,
  yearly: 1,
};

export interface FdInput {
  principal: number;
  annualRatePct: number;
  durationYears: number;
  compounding: FdCompounding;
}

export interface FdResult {
  invested: number;
  maturity: number;
  interest: number;
  effectiveYieldPct: number;
}

export function calcFd(input: FdInput): FdResult {
  const { principal, annualRatePct, durationYears, compounding } = input;
  if (principal <= 0 || durationYears <= 0) {
    return { invested: 0, maturity: 0, interest: 0, effectiveYieldPct: 0 };
  }
  const n = FREQ_PER_YEAR[compounding];
  const r = annualRatePct / 100;
  const maturity = principal * Math.pow(1 + r / n, n * durationYears);
  // Effective yield (annual) - slightly higher than nominal for n > 1.
  const effectiveYield = Math.pow(1 + r / n, n) - 1;
  return {
    invested: r2(principal),
    maturity: r2(maturity),
    interest: r2(maturity - principal),
    effectiveYieldPct: r2(effectiveYield * 100),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
