/**
 * Calculator config registry - B8 (MONEY-218-followup).
 *
 * One entry per slug on the /calculators index. Each entry declares:
 *   - the form fields (with sane Indian-retail defaults)
 *   - the calc function key (resolved client-side from the @usemoney/core
 *     /calc primitives)
 *   - the result row spec (label + value formatter + optional accent)
 *
 * Field types:
 *   "currency"  → ₹ prefix, locale grouping
 *   "percent"   → suffix %, decimal-form value
 *   "years"     → integer + suffix yrs (also accepts decimals like 1.5)
 *   "months"    → integer + suffix mo
 *   "select"    → controlled <select>
 *
 * Adding a calculator = (1) ensure a primitive in packages/core/src/calc,
 * (2) add a config row here, (3) thread the slug into /calculators/page.tsx
 * if it should be discoverable. No other changes.
 */

export type FieldKind =
  | "currency"
  | "percent"
  | "years"
  | "months"
  | "integer"
  | "select";

export interface FieldConfig {
  key: string;
  label: string;
  kind: FieldKind;
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  hint?: string;
}

export interface ResultRow {
  /** Result key - matches the property name on the calc result object. */
  key: string;
  label: string;
  /** Formatter hint - currency renders ₹; pct adds %; raw is identity. */
  format: "currency" | "pct" | "months" | "raw";
  /** Highlights this row visually (final value, big number). */
  accent?: boolean;
}

export interface CalcConfig {
  slug: string;
  name: string;
  blurb: string;
  /** Key resolved by the client to a calc primitive. */
  calcKey:
    | "sip"
    | "lumpsum"
    | "stepUpSip"
    | "emi"
    | "fd"
    | "rd"
    | "nps"
    | "incomeTax"
    | "goalSip"
    | "inflationSip"
    | "swp"
    | "xirr";
  fields: FieldConfig[];
  results: ResultRow[];
  /** Optional badge - shown next to the heading on the page. */
  badge?: string;
}

const SIP: CalcConfig = {
  slug: "sip",
  name: "SIP Calculator",
  blurb:
    "Project your final corpus from a fixed monthly investment. Matches SEBI's official SIP calculator (contribution at month end).",
  calcKey: "sip",
  fields: [
    {
      key: "monthly",
      label: "Monthly investment",
      kind: "currency",
      default: 10000,
      min: 100,
      max: 1_000_000,
      step: 500,
    },
    {
      key: "annualReturnPct",
      label: "Expected annual return",
      kind: "percent",
      default: 12,
      min: 0,
      max: 30,
      step: 0.5,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 10,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    { key: "invested", label: "Invested", format: "currency" },
    { key: "gain", label: "Gain", format: "currency" },
    {
      key: "finalValue",
      label: "Future value",
      format: "currency",
      accent: true,
    },
  ],
};

const LUMPSUM: CalcConfig = {
  slug: "lumpsum",
  name: "Lumpsum Calculator",
  blurb: "Future value of a one-time investment compounded annually.",
  calcKey: "lumpsum",
  fields: [
    {
      key: "principal",
      label: "Investment amount",
      kind: "currency",
      default: 100000,
      min: 1000,
      max: 100_000_000,
      step: 5000,
    },
    {
      key: "annualReturnPct",
      label: "Expected annual return",
      kind: "percent",
      default: 12,
      min: 0,
      max: 30,
      step: 0.5,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 10,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    { key: "invested", label: "Invested", format: "currency" },
    { key: "gain", label: "Gain", format: "currency" },
    {
      key: "finalValue",
      label: "Future value",
      format: "currency",
      accent: true,
    },
  ],
};

const STEP_UP_SIP: CalcConfig = {
  slug: "step-up-sip",
  name: "Step-up SIP Calculator",
  blurb:
    "Monthly SIP that grows by a fixed percentage each year - tracks salary growth.",
  calcKey: "stepUpSip",
  fields: [
    {
      key: "monthly",
      label: "Starting monthly",
      kind: "currency",
      default: 10000,
      min: 100,
      max: 1_000_000,
      step: 500,
    },
    {
      key: "annualReturnPct",
      label: "Expected annual return",
      kind: "percent",
      default: 12,
      min: 0,
      max: 30,
      step: 0.5,
    },
    {
      key: "stepUpPct",
      label: "Annual step-up",
      kind: "percent",
      default: 10,
      min: 0,
      max: 50,
      step: 1,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 15,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    { key: "invested", label: "Total invested", format: "currency" },
    { key: "gain", label: "Gain", format: "currency" },
    {
      key: "finalValue",
      label: "Future value",
      format: "currency",
      accent: true,
    },
  ],
};

const EMI: CalcConfig = {
  slug: "emi",
  name: "EMI Calculator",
  blurb:
    "Loan EMI with reducing-balance interest. Includes total interest paid.",
  calcKey: "emi",
  fields: [
    {
      key: "principal",
      label: "Loan amount",
      kind: "currency",
      default: 5000000,
      min: 10000,
      max: 1_000_000_000,
      step: 50000,
    },
    {
      key: "annualRatePct",
      label: "Interest rate",
      kind: "percent",
      default: 8.5,
      min: 1,
      max: 30,
      step: 0.05,
    },
    {
      key: "durationYears",
      label: "Tenure",
      kind: "years",
      default: 20,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    { key: "emi", label: "Monthly EMI", format: "currency", accent: true },
    { key: "totalInterest", label: "Total interest", format: "currency" },
    { key: "totalPayment", label: "Total payment", format: "currency" },
  ],
};

const FD: CalcConfig = {
  slug: "fd",
  name: "FD Calculator",
  blurb: "Maturity value with configurable compounding frequency.",
  calcKey: "fd",
  fields: [
    {
      key: "principal",
      label: "Principal",
      kind: "currency",
      default: 100000,
      min: 1000,
      max: 100_000_000,
      step: 5000,
    },
    {
      key: "annualRatePct",
      label: "Interest rate",
      kind: "percent",
      default: 7,
      min: 1,
      max: 15,
      step: 0.05,
    },
    {
      key: "durationYears",
      label: "Tenure",
      kind: "years",
      default: 5,
      min: 0.25,
      max: 10,
      step: 0.25,
    },
    {
      key: "compounding",
      label: "Compounding",
      kind: "select",
      default: "quarterly",
      options: [
        { value: "monthly", label: "Monthly" },
        { value: "quarterly", label: "Quarterly" },
        { value: "half-yearly", label: "Half-yearly" },
        { value: "yearly", label: "Yearly" },
      ],
    },
  ],
  results: [
    { key: "invested", label: "Principal", format: "currency" },
    { key: "interest", label: "Interest earned", format: "currency" },
    {
      key: "maturity",
      label: "Maturity value",
      format: "currency",
      accent: true,
    },
    { key: "effectiveYieldPct", label: "Effective yield", format: "pct" },
  ],
};

const RD: CalcConfig = {
  slug: "rd",
  name: "RD Calculator",
  blurb:
    "Monthly recurring deposit with quarterly compounding (matches Indian bank RDs).",
  calcKey: "rd",
  fields: [
    {
      key: "monthly",
      label: "Monthly deposit",
      kind: "currency",
      default: 5000,
      min: 100,
      max: 1_000_000,
      step: 500,
    },
    {
      key: "annualRatePct",
      label: "Interest rate",
      kind: "percent",
      default: 6.5,
      min: 1,
      max: 12,
      step: 0.05,
    },
    {
      key: "durationYears",
      label: "Tenure",
      kind: "years",
      default: 5,
      min: 0.5,
      max: 10,
      step: 0.5,
    },
  ],
  results: [
    { key: "invested", label: "Total deposited", format: "currency" },
    { key: "interest", label: "Interest earned", format: "currency" },
    {
      key: "maturity",
      label: "Maturity value",
      format: "currency",
      accent: true,
    },
  ],
};

const NPS: CalcConfig = {
  slug: "nps",
  name: "NPS Calculator",
  blurb:
    "National Pension System - accumulates a corpus then splits it into a lump-sum and an annuity.",
  calcKey: "nps",
  fields: [
    {
      key: "monthly",
      label: "Monthly contribution",
      kind: "currency",
      default: 5000,
      min: 500,
      max: 200000,
      step: 500,
    },
    {
      key: "currentAge",
      label: "Current age",
      kind: "integer",
      default: 30,
      min: 18,
      max: 65,
      step: 1,
    },
    {
      key: "retirementAge",
      label: "Retirement age",
      kind: "integer",
      default: 60,
      min: 40,
      max: 75,
      step: 1,
    },
    {
      key: "preReturnPct",
      label: "Pre-retirement return",
      kind: "percent",
      default: 10,
      min: 4,
      max: 18,
      step: 0.5,
    },
    {
      key: "annuityPct",
      label: "Annuity allocation",
      kind: "percent",
      default: 40,
      min: 40,
      max: 100,
      step: 5,
      hint: "NPS rules require at least 40% to buy an annuity.",
    },
    {
      key: "annuityRatePct",
      label: "Annuity rate (post)",
      kind: "percent",
      default: 6,
      min: 4,
      max: 9,
      step: 0.25,
    },
  ],
  results: [
    { key: "corpus", label: "Total corpus", format: "currency" },
    { key: "lumpsum", label: "Lump-sum at retirement", format: "currency" },
    { key: "annuityCorpus", label: "Annuity corpus", format: "currency" },
    {
      key: "monthlyPension",
      label: "Monthly pension",
      format: "currency",
      accent: true,
    },
  ],
};

const INCOME_TAX: CalcConfig = {
  slug: "income-tax",
  name: "Income Tax Calculator",
  blurb:
    "FY 25-26 tax under the new regime - slabs, 87A rebate, surcharge bands, 4% cess.",
  calcKey: "incomeTax",
  fields: [
    {
      key: "income",
      label: "Gross annual income",
      kind: "currency",
      default: 1500000,
      min: 0,
      max: 100_000_000,
      step: 10000,
    },
    {
      key: "regime",
      label: "Regime",
      kind: "select",
      default: "new",
      options: [
        { value: "new", label: "New (FY 25-26)" },
        { value: "old", label: "Old" },
      ],
    },
    {
      key: "deductions",
      label: "Deductions (old regime only)",
      kind: "currency",
      default: 0,
      min: 0,
      max: 5_000_000,
      step: 5000,
    },
  ],
  results: [
    { key: "taxableIncome", label: "Taxable income", format: "currency" },
    { key: "taxBeforeRebate", label: "Slab tax", format: "currency" },
    { key: "rebate", label: "87A rebate", format: "currency" },
    { key: "surcharge", label: "Surcharge", format: "currency" },
    { key: "cess", label: "Cess (4%)", format: "currency" },
    {
      key: "totalTax",
      label: "Total tax",
      format: "currency",
      accent: true,
    },
  ],
};

const MF_LUMPSUM: CalcConfig = {
  ...LUMPSUM,
  slug: "mf-lumpsum",
  name: "MF Lumpsum Calculator",
  blurb:
    "Mutual fund one-time investment. Default 12% return - actual-fund XIRR mode coming soon.",
  badge: "MF",
};

const MF_SIP: CalcConfig = {
  ...SIP,
  slug: "mf-sip",
  name: "MF SIP Calculator",
  blurb:
    "Mutual fund SIP. Default 12% return - actual-fund XIRR mode coming soon.",
  badge: "MF",
};

const MF_STEP_UP_SIP: CalcConfig = {
  ...STEP_UP_SIP,
  slug: "mf-step-up-sip",
  name: "MF Step-up SIP Calculator",
  blurb:
    "Mutual fund SIP that increases each year. Default assumed return - actual-fund mode coming soon.",
  badge: "MF",
};

const MF_GOAL_SIP: CalcConfig = {
  slug: "mf-goal-sip",
  name: "Goal SIP Calculator",
  blurb: "Back-solve the monthly SIP needed to reach a target corpus.",
  calcKey: "goalSip",
  badge: "MF",
  fields: [
    {
      key: "goal",
      label: "Target corpus",
      kind: "currency",
      default: 10000000,
      min: 10000,
      max: 1_000_000_000,
      step: 50000,
    },
    {
      key: "annualReturnPct",
      label: "Expected return",
      kind: "percent",
      default: 12,
      min: 0,
      max: 30,
      step: 0.5,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 15,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    {
      key: "monthlyRequired",
      label: "Monthly SIP needed",
      format: "currency",
      accent: true,
    },
    { key: "totalInvested", label: "Total invested", format: "currency" },
    { key: "futureValue", label: "Future value", format: "currency" },
  ],
};

const MF_INFLATION_SIP: CalcConfig = {
  slug: "mf-inflation-sip",
  name: "Inflation-adjusted SIP",
  blurb:
    "Project both the nominal corpus and its purchasing power in today's rupees (Fisher real-rate adjustment).",
  calcKey: "inflationSip",
  badge: "MF",
  fields: [
    {
      key: "monthly",
      label: "Monthly SIP",
      kind: "currency",
      default: 10000,
      min: 100,
      max: 1_000_000,
      step: 500,
    },
    {
      key: "nominalReturnPct",
      label: "Nominal return",
      kind: "percent",
      default: 12,
      min: 0,
      max: 30,
      step: 0.5,
    },
    {
      key: "inflationPct",
      label: "Inflation",
      kind: "percent",
      default: 6,
      min: 0,
      max: 15,
      step: 0.25,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 20,
      min: 1,
      max: 40,
      step: 1,
    },
  ],
  results: [
    { key: "invested", label: "Total invested", format: "currency" },
    {
      key: "finalValueNominal",
      label: "Final corpus (nominal)",
      format: "currency",
    },
    {
      key: "finalValueReal",
      label: "Final corpus (today's ₹)",
      format: "currency",
      accent: true,
    },
    { key: "realReturnPct", label: "Real return", format: "pct" },
  ],
};

const MF_XIRR: CalcConfig = {
  slug: "mf-returns-xirr",
  name: "MF Returns (XIRR)",
  blurb:
    "Compute XIRR from a series of irregular cashflows - same algorithm as Excel/Sheets XIRR.",
  calcKey: "xirr",
  badge: "MF",
  fields: [], // Custom builder rendered separately
  results: [
    { key: "xirr", label: "Annualised return", format: "pct", accent: true },
  ],
};

const MF_SWP: CalcConfig = {
  slug: "mf-swp",
  name: "SWP Calculator",
  blurb:
    "Systematic withdrawal - projects when the corpus depletes given a fixed monthly withdrawal.",
  calcKey: "swp",
  badge: "MF",
  fields: [
    {
      key: "initialCorpus",
      label: "Starting corpus",
      kind: "currency",
      default: 10000000,
      min: 10000,
      max: 1_000_000_000,
      step: 50000,
    },
    {
      key: "monthlyWithdrawal",
      label: "Monthly withdrawal",
      kind: "currency",
      default: 50000,
      min: 100,
      max: 10_000_000,
      step: 1000,
    },
    {
      key: "annualReturnPct",
      label: "Expected return",
      kind: "percent",
      default: 8,
      min: 0,
      max: 25,
      step: 0.5,
    },
    {
      key: "durationYears",
      label: "Duration",
      kind: "years",
      default: 20,
      min: 1,
      max: 50,
      step: 1,
    },
  ],
  results: [
    { key: "totalWithdrawn", label: "Total withdrawn", format: "currency" },
    {
      key: "finalBalance",
      label: "Final balance",
      format: "currency",
      accent: true,
    },
    { key: "monthsLasted", label: "Months lasted", format: "months" },
  ],
};

export const CALC_CONFIGS: Record<string, CalcConfig> = {
  sip: SIP,
  lumpsum: LUMPSUM,
  "step-up-sip": STEP_UP_SIP,
  emi: EMI,
  fd: FD,
  rd: RD,
  nps: NPS,
  "income-tax": INCOME_TAX,
  "mf-lumpsum": MF_LUMPSUM,
  "mf-sip": MF_SIP,
  "mf-step-up-sip": MF_STEP_UP_SIP,
  "mf-goal-sip": MF_GOAL_SIP,
  "mf-inflation-sip": MF_INFLATION_SIP,
  "mf-returns-xirr": MF_XIRR,
  "mf-swp": MF_SWP,
};

export const CALC_SLUGS = Object.keys(CALC_CONFIGS);
