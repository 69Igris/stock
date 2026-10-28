/* =====================================================================
   Tax Report v2 — shared regime slab math (MONEY-485)
   Single source of truth for the indicative Old vs New regime slab tax.
   Used by both TaxRegimeCallout (header) and the Optimize regime sandbox
   so the two never diverge. These are INDICATIVE slab estimates — actual
   regime totals come from the tax service once it exposes them.
   ===================================================================== */

/** New regime slab tax (FY 2025-26+). ₹7L rebate, ₹75k std deduction handled by caller. */
export function newRegimeTax(income: number): number {
  if (income <= 700_000) return 0;
  const slabs: Array<[number, number, number]> = [
    [0, 300_000, 0],
    [300_000, 600_000, 0.05],
    [600_000, 900_000, 0.1],
    [900_000, 1_200_000, 0.15],
    [1_200_000, 1_500_000, 0.2],
    [1_500_000, Infinity, 0.3],
  ];
  let tax = 0;
  for (const [from, to, rate] of slabs) {
    if (income > from) tax += (Math.min(income, to) - from) * rate;
  }
  return Math.round(tax);
}

/** Old regime slab tax — indicative, applies a flat 5% deduction proxy for 80C. */
export function oldRegimeTax(income: number): number {
  if (income <= 250_000) return 0;
  const slabs: Array<[number, number, number]> = [
    [0, 250_000, 0],
    [250_000, 500_000, 0.05],
    [500_000, 1_000_000, 0.2],
    [1_000_000, Infinity, 0.3],
  ];
  let tax = 0;
  for (const [from, to, rate] of slabs) {
    if (income > from) tax += (Math.min(income, to) - from) * rate;
  }
  return Math.round(tax * 0.95);
}

export const NEW_REGIME_SLABS: Array<[string, string]> = [
  ["₹0 – ₹3L", "Nil"],
  ["₹3L – ₹6L", "5%"],
  ["₹6L – ₹9L", "10%"],
  ["₹9L – ₹12L", "15%"],
  ["₹12L – ₹15L", "20%"],
  ["> ₹15L", "30%"],
];

export const OLD_REGIME_SLABS: Array<[string, string]> = [
  ["₹0 – ₹2.5L", "Nil"],
  ["₹2.5L – ₹5L", "5%"],
  ["₹5L – ₹10L", "20%"],
  ["> ₹10L", "30%"],
];
