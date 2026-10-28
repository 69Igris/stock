/**
 * Income tax - old vs new regime side-by-side (FY 25-26 / 26-27).
 *
 * Slabs are the budget-2025 numbers (FY 25-26 onward). When new
 * budget rates ship, add a new entry to SLABS_BY_FY and bump the
 * default in `calcIncomeTax`.
 *
 * Returns BOTH regimes so the UI can show a comparison and recommend
 * the cheaper one. Surcharge + cess are applied per the standard
 * formula.
 */

export type IncomeTaxRegime = "old" | "new";

export interface IncomeTaxInput {
  /** Gross annual income in rupees. */
  income: number;
  regime: IncomeTaxRegime;
  /** Total deductions claimable (only applies to old regime). */
  deductions?: number;
  /**
   * Standard deduction in rupees. Defaults PER REGIME — ₹75,000 for the new
   * regime, ₹50,000 for the old (FY 25-26). Pass a value only to override.
   */
  standardDeduction?: number;
  /** Financial year, e.g. "25-26", "26-27". Defaults to latest known. */
  fy?: string;
}

export interface IncomeTaxResult {
  taxableIncome: number;
  taxBeforeRebate: number;
  rebate: number;
  surcharge: number;
  cess: number;
  totalTax: number;
}

interface Slab {
  upto: number; // inclusive upper bound; Infinity for last slab
  rate: number; // 0–1
}

/**
 * FY 25-26 onwards (Budget 2025) - new regime is the default per the
 * Finance Act. Old regime kept for users with significant deductions.
 */
const NEW_REGIME_SLABS_25_26: Slab[] = [
  { upto: 400_000, rate: 0 },
  { upto: 800_000, rate: 0.05 },
  { upto: 1_200_000, rate: 0.1 },
  { upto: 1_600_000, rate: 0.15 },
  { upto: 2_000_000, rate: 0.2 },
  { upto: 2_400_000, rate: 0.25 },
  { upto: Infinity, rate: 0.3 },
];

const OLD_REGIME_SLABS_25_26: Slab[] = [
  { upto: 250_000, rate: 0 },
  { upto: 500_000, rate: 0.05 },
  { upto: 1_000_000, rate: 0.2 },
  { upto: Infinity, rate: 0.3 },
];

interface FyConfig {
  newSlabs: Slab[];
  oldSlabs: Slab[];
  newRebateUpto: number;
  oldRebateUpto: number;
  // Both of these differ BY REGIME and used to be single shared fields, which
  // is how the standard deduction ended up wrong — a regime-specific value in a
  // regime-blind field reads as correct right up until the two regimes diverge,
  // and they diverged in Budget 2024.
  newRebateMax: number;
  oldRebateMax: number;
  newStandardDeduction: number;
  oldStandardDeduction: number;
}

const FY_CONFIG: Record<string, FyConfig> = {
  "25-26": {
    newSlabs: NEW_REGIME_SLABS_25_26,
    oldSlabs: OLD_REGIME_SLABS_25_26,
    // 87A rebate: full tax rebate up to ₹12L taxable in new regime
    // (per Finance Act 2025), ₹5L in old.
    newRebateUpto: 1_200_000,
    oldRebateUpto: 500_000,
    // 87A caps. ₹60,000 is the new-regime figure from the Finance Act 2025;
    // the old regime's cap has been ₹12,500 throughout. These shared a single
    // `rebateMax: 60_000` field. That was latent rather than active — old-regime
    // tax at ≤₹5L taxable tops out at ₹12,500, so `min(tax, cap)` returned the
    // tax whichever cap was used — but it is a wrong constant sitting one slab
    // change away from mattering.
    newRebateMax: 60_000,
    oldRebateMax: 12_500,
    // Standard deduction. Budget 2024 raised the NEW regime's to ₹75,000 and
    // left the old at ₹50,000; a single shared ₹50,000 charged every new-regime
    // user tax on an extra ₹25,000 of income — ₹3,900 too much at ₹15L, ₹7,800
    // at ₹25L. Overstating someone's tax bill is the worst direction for this
    // error to run.
    newStandardDeduction: 75_000,
    oldStandardDeduction: 50_000,
  },
};

const SURCHARGE_BANDS = [
  { upto: 5_000_000, rate: 0 },
  { upto: 10_000_000, rate: 0.1 },
  { upto: 20_000_000, rate: 0.15 },
  { upto: 50_000_000, rate: 0.25 },
  { upto: Infinity, rate: 0.37 },
];

const CESS_RATE = 0.04;

export function calcIncomeTax(input: IncomeTaxInput): IncomeTaxResult {
  const fy = input.fy ?? "25-26";
  const cfg = FY_CONFIG[fy] ?? FY_CONFIG["25-26"]!;
  const slabs = input.regime === "old" ? cfg.oldSlabs : cfg.newSlabs;
  const isOld = input.regime === "old";
  const rebateUpto = isOld ? cfg.oldRebateUpto : cfg.newRebateUpto;
  const rebateMax = isOld ? cfg.oldRebateMax : cfg.newRebateMax;

  // Non-finite money inputs (NaN / ±Infinity) must NOT leak into the result.
  // `Math.max(0, NaN)` is NaN, so the existing clamps below don't catch them —
  // a single garbage figure used to propagate all the way to `totalTax: NaN`
  // (a corrupt tax number rendered straight to the user). Treat any non-finite
  // amount as 0, the safe-by-default "no contribution" value.
  const income = finiteOr0(input.income);
  // A non-finite override falls back to the configured default standard
  // deduction (not 0), so a bad client value can't silently inflate taxable.
  const std = Number.isFinite(input.standardDeduction)
    ? (input.standardDeduction as number)
    : isOld
      ? cfg.oldStandardDeduction
      : cfg.newStandardDeduction;

  const deductions =
    input.regime === "old" ? Math.max(0, finiteOr0(input.deductions)) : 0;
  const taxable = Math.max(0, income - std - deductions);

  // Slab tax
  let tax = 0;
  let prevUpto = 0;
  for (const slab of slabs) {
    const slice = Math.max(0, Math.min(taxable, slab.upto) - prevUpto);
    tax += slice * slab.rate;
    prevUpto = slab.upto;
    if (taxable <= slab.upto) break;
  }

  // 87A rebate
  let rebate = 0;
  if (taxable <= rebateUpto) {
    rebate = Math.min(tax, rebateMax);
  }
  const taxAfterRebate = Math.max(0, tax - rebate);

  // Surcharge
  const surchargeBand = SURCHARGE_BANDS.find((b) => income <= b.upto);
  const surcharge = taxAfterRebate * (surchargeBand?.rate ?? 0);

  // Cess
  const cess = (taxAfterRebate + surcharge) * CESS_RATE;

  return {
    taxableIncome: r2(taxable),
    taxBeforeRebate: r2(tax),
    rebate: r2(rebate),
    surcharge: r2(surcharge),
    cess: r2(cess),
    totalTax: r2(taxAfterRebate + surcharge + cess),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Coerce a non-finite number (NaN / ±Infinity / undefined) to 0; pass finite values through. */
function finiteOr0(n: number | undefined): number {
  return Number.isFinite(n) ? (n as number) : 0;
}
