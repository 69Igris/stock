/**
 * Guidance Sensitivity Analysis
 *
 * Sensitivity of forward EPS / implied value to revenue-growth and
 * operating-margin assumptions. Builds a 3x3 scenario grid
 * (revenueGrowth in {base-3pp, base, base+3pp} x operatingMargin in
 * {base-2pp, base, base+2pp}) and measures which lever (+1pp growth vs
 * +1pp margin) moves forward EPS more.
 *
 * PURE compute tool - all inputs injected by the executor from upstream
 * fetch results. No network/db/io. Observations only (SEBI: no
 * buy/sell/hold/target-price language).
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface GuidanceSensitivityCell {
  revenueGrowth: number; // decimal, e.g. 0.1 = 10%
  operatingMargin: number; // decimal, e.g. 0.2 = 20%
  projRevenue: number;
  projEbit: number;
  projNetIncome: number;
  projEps: number;
  impliedValue: number | null; // projEps * pe, null when pe unavailable
}

export interface GuidanceSensitivityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  // Base-case assumptions used to anchor the grid
  assumptions?: {
    revenue: number;
    baseGrowth: number; // decimal
    baseMargin: number; // decimal
    sharesOutstanding: number;
    pe: number | null;
    taxRate: number;
    currentPrice: number | null;
    growthAssumed: boolean; // true if base growth defaulted to 10%
    marginAssumed: boolean; // true if base margin defaulted
  };
  baseEps?: number;
  bullEps?: number; // top-right cell: +3pp growth, +2pp margin
  bearEps?: number; // bottom-left cell: -3pp growth, -2pp margin
  baseImpliedValue?: number | null;
  bullImpliedValue?: number | null;
  bearImpliedValue?: number | null;
  // Elasticity of base EPS to a +1pp move in each lever
  epsElasticity?: {
    perPpGrowth: number; // delta EPS from +1pp revenue growth
    perPpMargin: number; // delta EPS from +1pp operating margin
    dominantLever: "growth" | "margin" | "balanced";
  };
  grid?: GuidanceSensitivityCell[]; // 9 cells (3 growth x 3 margin)
  flags: string[];
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Round to a sensible number of decimals. */
function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/** Normalize a percentage-ish input into a decimal fraction (0.20 == 20%). */
function toFraction(v: number | null): number | null {
  if (v === null) return null;
  // Values above 1 (or below -1) are assumed to be expressed in percent.
  return Math.abs(v) > 1 ? v / 100 : v;
}

export const computeGuidanceSensitivityTool: ResearchToolDef = {
  name: "compute_guidance_sensitivity",
  description:
    "Sensitivity of forward EPS / implied value to revenue-growth and operating-margin assumptions (3x3 grid)",
  category: "computation",
  parameters: {
    revenue: {
      type: "number",
      description: "Latest annual revenue (from fetch_income_statement)",
      required: true,
    },
    operatingMargin: {
      type: "number",
      description:
        "Base operating margin as a decimal or percent (e.g. 0.20 or 20). If absent, derived from operatingIncome/revenue.",
    },
    operatingIncome: {
      type: "number",
      description:
        "Latest annual operating income / EBIT - used to derive margin when operatingMargin is absent",
    },
    revenueGrowth: {
      type: "number",
      description:
        "Base revenue-growth assumption as a decimal or percent. Defaults to 10% when unknown.",
    },
    sharesOutstanding: {
      type: "number",
      description:
        "Shares outstanding (from marketCap/price when absent upstream)",
      required: true,
    },
    pe: {
      type: "number",
      description: "Price-to-earnings multiple (from fetch_key_ratios.pe)",
    },
    currentPrice: {
      type: "number",
      description: "Current stock price (from fetch_stock_price)",
    },
    taxRate: {
      type: "number",
      description: "Effective tax rate as a decimal. Defaults to 0.25 (25%).",
      default: 0.25,
    },
    symbol: { type: "string", description: "Stock symbol for labelling" },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string" && params.symbol.length > 0
        ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
        : undefined;

    try {
      const revenue = toNum(params.revenue);
      const sharesOutstanding = toNum(params.sharesOutstanding);

      // Graceful degradation: cannot project EPS without revenue + share count.
      if (revenue === null || revenue <= 0) {
        return {
          success: true,
          data: {
            available: false,
            reason: "revenue unavailable - cannot project forward EPS",
            symbol,
            flags: [],
          } satisfies GuidanceSensitivityResult,
        };
      }
      if (sharesOutstanding === null || sharesOutstanding <= 0) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "sharesOutstanding unavailable - cannot convert net income to EPS",
            symbol,
            flags: [],
          } satisfies GuidanceSensitivityResult,
        };
      }

      const flags: string[] = [];

      // ─── Base margin ────────────────────────────────────────
      let baseMargin = toFraction(toNum(params.operatingMargin));
      let marginAssumed = false;
      if (baseMargin === null) {
        const operatingIncome = toNum(params.operatingIncome);
        if (operatingIncome !== null) {
          baseMargin = operatingIncome / revenue;
        }
      }
      if (baseMargin === null) {
        baseMargin = 0.15; // neutral fallback when margin truly unknown
        marginAssumed = true;
        flags.push(
          "Operating margin unavailable - base margin assumed at 15% (interpret grid as illustrative)",
        );
      }
      // Clamp to a sane band so the grid stays meaningful.
      baseMargin = Math.max(-0.5, Math.min(0.6, baseMargin));

      // ─── Base growth ────────────────────────────────────────
      let baseGrowth = toFraction(toNum(params.revenueGrowth));
      let growthAssumed = false;
      if (baseGrowth === null) {
        baseGrowth = 0.1; // default 10% per product spec
        growthAssumed = true;
        flags.push(
          "Revenue-growth guidance unavailable - base growth assumed at 10%",
        );
      }

      // ─── Tax rate ───────────────────────────────────────────
      let taxRate = toFraction(toNum(params.taxRate));
      if (taxRate === null) taxRate = 0.25;
      taxRate = Math.max(0, Math.min(0.6, taxRate));

      const pe = (() => {
        const p = toNum(params.pe);
        return p !== null && p > 0 ? p : null;
      })();
      const currentPrice = (() => {
        const p = toNum(params.currentPrice);
        return p !== null && p > 0 ? p : null;
      })();

      // ─── EPS projector for a single (growth, margin) pair ───
      const project = (g: number, margin: number): GuidanceSensitivityCell => {
        const projRevenue = revenue * (1 + g);
        const projEbit = projRevenue * margin;
        const projNetIncome = projEbit * (1 - taxRate);
        const projEps = projNetIncome / sharesOutstanding;
        const impliedValue = pe !== null ? projEps * pe : null;
        return {
          revenueGrowth: round(g, 4),
          operatingMargin: round(margin, 4),
          projRevenue: round(projRevenue, 2),
          projEbit: round(projEbit, 2),
          projNetIncome: round(projNetIncome, 2),
          projEps: round(projEps, 2),
          impliedValue: impliedValue !== null ? round(impliedValue, 2) : null,
        };
      };

      // ─── Grid axes ──────────────────────────────────────────
      // Growth: base-3pp, base, base+3pp ; Margin: base-2pp, base, base+2pp.
      const growthAxis = [baseGrowth - 0.03, baseGrowth, baseGrowth + 0.03];
      const marginAxis = [
        Math.max(-0.5, baseMargin - 0.02),
        baseMargin,
        Math.min(0.6, baseMargin + 0.02),
      ];

      const grid: GuidanceSensitivityCell[] = [];
      for (const g of growthAxis) {
        for (const m of marginAxis) {
          grid.push(project(g, m));
        }
      }

      // ─── Anchor cells ───────────────────────────────────────
      const baseCell = project(baseGrowth, baseMargin);
      const bullCell = project(baseGrowth + 0.03, baseMargin + 0.02);
      const bearCell = project(baseGrowth - 0.03, baseMargin - 0.02);

      const baseEps = baseCell.projEps;
      const bullEps = bullCell.projEps;
      const bearEps = bearCell.projEps;

      // ─── Elasticity to a +1pp move in each lever ────────────
      const epsAtGrowthPp = project(baseGrowth + 0.01, baseMargin).projEps;
      const epsAtMarginPp = project(baseGrowth, baseMargin + 0.01).projEps;
      const perPpGrowth = round(epsAtGrowthPp - baseEps, 4);
      const perPpMargin = round(epsAtMarginPp - baseEps, 4);

      let dominantLever: "growth" | "margin" | "balanced";
      const absG = Math.abs(perPpGrowth);
      const absM = Math.abs(perPpMargin);
      const larger = Math.max(absG, absM);
      if (larger === 0) {
        dominantLever = "balanced";
      } else if (Math.abs(absG - absM) / larger < 0.1) {
        dominantLever = "balanced";
      } else {
        dominantLever = absG > absM ? "growth" : "margin";
      }

      // ─── Observation flags (SEBI-safe, no advice) ───────────
      if (dominantLever === "margin") {
        flags.push(
          "Forward EPS is more sensitive to operating-margin changes than to revenue-growth changes",
        );
      } else if (dominantLever === "growth") {
        flags.push(
          "Forward EPS is more sensitive to revenue-growth changes than to operating-margin changes",
        );
      } else {
        flags.push(
          "Revenue-growth and operating-margin levers move forward EPS by a similar amount",
        );
      }

      if (bearCell.projNetIncome < 0) {
        flags.push(
          "Bear case (lower growth and margin) implies negative net income",
        );
      }
      if (baseMargin <= 0) {
        flags.push(
          "Base operating margin is non-positive - implied-value figures are unreliable",
        );
      }
      if (baseEps !== 0) {
        const epsSwing = round(((bullEps - bearEps) / Math.abs(baseEps)) * 100, 1);
        flags.push(
          `Forward EPS swings ~${epsSwing}% across the bull-to-bear grid corners`,
        );
      }
      if (pe === null) {
        flags.push(
          "PE multiple unavailable - implied-value column omitted, EPS grid still computed",
        );
      }

      const result: GuidanceSensitivityResult = {
        available: true,
        symbol,
        assumptions: {
          revenue: round(revenue, 2),
          baseGrowth: round(baseGrowth, 4),
          baseMargin: round(baseMargin, 4),
          sharesOutstanding: round(sharesOutstanding, 2),
          pe,
          taxRate: round(taxRate, 4),
          currentPrice,
          growthAssumed,
          marginAssumed,
        },
        baseEps,
        bullEps,
        bearEps,
        baseImpliedValue: baseCell.impliedValue,
        bullImpliedValue: bullCell.impliedValue,
        bearImpliedValue: bearCell.impliedValue,
        epsElasticity: {
          perPpGrowth,
          perPpMargin,
          dominantLever,
        },
        grid,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Guidance sensitivity analysis failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
