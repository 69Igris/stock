/**
 * NPS - National Pension System.
 *
 * Inputs: monthly contribution, current age, retirement age, expected
 * pre-retirement annual return, post-retirement annuity rate, and
 * the percentage of corpus used to buy an annuity (NPS rules require
 * at least 40% - most users pick 40-60%).
 *
 * Output:
 *   - corpus accumulated at retirement (uses calcSip primitive)
 *   - lump-sum withdrawn at retirement (corpus × lumpsumPct)
 *   - annuity corpus (corpus × annuityPct)
 *   - monthly pension from annuity (annuityCorpus × annuityRate / 12)
 */

import { calcSip } from "./sip";

export interface NpsInput {
  monthly: number;
  currentAge: number;
  retirementAge: number;
  preReturnPct: number;
  /** Annuity provider's annual rate (typically 5–6%). */
  annuityRatePct: number;
  /** Fraction (0-1) of corpus used to buy annuity. NPS requires ≥ 0.4. */
  annuityPct: number;
}

export interface NpsResult {
  corpus: number;
  lumpsum: number;
  annuityCorpus: number;
  monthlyPension: number;
}

export function calcNps(input: NpsInput): NpsResult {
  const {
    monthly,
    currentAge,
    retirementAge,
    preReturnPct,
    annuityRatePct,
    annuityPct,
  } = input;
  const years = Math.max(0, retirementAge - currentAge);
  if (years <= 0 || monthly <= 0) {
    return { corpus: 0, lumpsum: 0, annuityCorpus: 0, monthlyPension: 0 };
  }
  const sip = calcSip({
    monthly,
    annualReturnPct: preReturnPct,
    durationYears: years,
  });
  const corpus = sip.finalValue;
  const annuityCorpus = corpus * Math.max(0, Math.min(1, annuityPct));
  const lumpsum = corpus - annuityCorpus;
  const monthlyPension = (annuityCorpus * (annuityRatePct / 100)) / 12;
  return {
    corpus: r2(corpus),
    lumpsum: r2(lumpsum),
    annuityCorpus: r2(annuityCorpus),
    monthlyPension: r2(monthlyPension),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
