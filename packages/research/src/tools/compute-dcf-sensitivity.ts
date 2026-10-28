/**
 * DCF Sensitivity Analysis (2-D)
 *
 * Re-runs the multi-stage DCF intrinsic-value calculation across a grid of
 * assumptions to show how fragile the fair value is to small input changes.
 *   - Grid A: discount rate (WACC) x terminal growth
 *   - Grid B: discount rate (WACC) x FCF (stage-1) growth
 * Mirrors compute_dcf's math exactly so the base cell reconciles with it.
 *
 * PURE compute tool - no IO. Inputs are injected by the executor from the
 * upstream compute_dcf / compute_wacc / fetch_stock_price results.
 *
 * SEBI: outputs OBSERVATIONS, ranges and flags only. No buy/sell/target advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result ─────────────────────────────────────────────────

export interface DcfSensitivityCell {
  discountRate: number; // WACC used for this cell (decimal)
  variable: number; // terminal growth (Grid A) or FCF growth (Grid B), decimal
  intrinsicValue: number; // per-share intrinsic value, rounded to 2dp
  upside: number; // vs currentPrice, % rounded to 1dp (null-safe → 0 when no price)
  valid: boolean; // false when WACC <= terminal growth (model undefined)
}

export interface DcfSensitivityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Base-case intrinsic value (g, tg, wacc at their base values). */
  intrinsicValue?: number;
  currentPrice?: number;
  /** Base-case upside vs currentPrice, %. */
  upside?: number;
  /** Base-case margin of safety, %. */
  marginOfSafety?: number;
  /** Assumptions used for the base case. */
  base?: {
    discountRate: number;
    terminalGrowthRate: number;
    fcfGrowthRate: number;
    fcf: number;
    projectionYears: number;
    sharesOutstanding: number;
  };
  /** Grid A axes: WACC rows, terminal-growth columns. */
  discountRateAxis?: number[];
  terminalGrowthAxis?: number[];
  fcfGrowthAxis?: number[];
  /** Grid A: discount rate x terminal growth. matrixA[row][col]. */
  matrixA?: DcfSensitivityCell[][];
  /** Grid B: discount rate x FCF growth. matrixB[row][col]. */
  matrixB?: DcfSensitivityCell[][];
  /** Min/max plausible intrinsic value across all valid cells. */
  fairValueRange?: { min: number; max: number };
  /** Range width as a % of base intrinsic value. */
  rangeWidthPercent?: number;
  /** Observational flags (no advice). */
  flags?: string[];
}

// ─── Helpers ────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function round(v: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/**
 * Multi-stage DCF intrinsic value per share. Identical formulation to
 * compute_dcf: project stage-1 FCF at growth g for N years, add a Gordon
 * terminal value FCF_N*(1+tg)/(wacc-tg), discount all at wacc, divide by shares.
 * Returns undefined when the model is undefined (wacc <= tg).
 */
function dcfPerShare(
  fcf: number,
  growth: number,
  terminalGrowth: number,
  wacc: number,
  years: number,
  shares: number,
): number | undefined {
  if (!(wacc > terminalGrowth) || shares <= 0) return undefined;
  let pv = 0;
  for (let i = 1; i <= years; i++) {
    pv += (fcf * Math.pow(1 + growth, i)) / Math.pow(1 + wacc, i);
  }
  const terminalFcf = fcf * Math.pow(1 + growth, years) * (1 + terminalGrowth);
  const terminalValue = terminalFcf / (wacc - terminalGrowth);
  pv += terminalValue / Math.pow(1 + wacc, years);
  return pv / shares;
}

// ─── Tool ───────────────────────────────────────────────────

export const computeDcfSensitivityTool: ResearchToolDef = {
  name: "compute_dcf_sensitivity",
  description:
    "2-D DCF sensitivity grids (WACC x terminal growth, WACC x FCF growth) - fair value range and fragility flags",
  category: "computation",
  parameters: {
    dcfAssumptions: {
      type: "object",
      description:
        "Assumptions object from compute_dcf.assumptions { fcf, growthRate, terminalGrowthRate, discountRate, projectionYears }",
    },
    intrinsicValue: {
      type: "number",
      description: "Base intrinsic value from compute_dcf (reconciliation only)",
    },
    wacc: {
      type: "number",
      description:
        "WACC from compute_wacc (decimal) - used as the base discount rate if provided",
    },
    currentPrice: {
      type: "number",
      description: "Current stock price (from fetch_stock_price)",
    },
    marketCap: {
      type: "number",
      description: "Market capitalization (to derive shares if missing)",
    },
    sharesOutstanding: {
      type: "number",
      description: "Total shares outstanding (else derived from marketCap/price)",
    },
    symbol: { type: "string", description: "NSE/BSE symbol (for labelling)" },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol = ((params.symbol as string) || "")
        .replace(/\.(NS|BO)$/i, "")
        .toUpperCase();

      // Unpack the compute_dcf assumptions blob (graceful nullish handling).
      const assumptions =
        params.dcfAssumptions && typeof params.dcfAssumptions === "object"
          ? (params.dcfAssumptions as Record<string, unknown>)
          : {};

      const fcf = num(assumptions.fcf) ?? num(params.fcf) ?? num(params.freeCashFlow);
      const baseGrowth =
        num(assumptions.growthRate) ?? num(params.growthRate) ?? 0.12;
      const baseTerminalGrowth =
        num(assumptions.terminalGrowthRate) ??
        num(params.terminalGrowthRate) ??
        0.03;
      const dcfDiscount = num(assumptions.discountRate);
      const projectionYears = Math.max(
        1,
        Math.round(
          num(assumptions.projectionYears) ?? num(params.projectionYears) ?? 10,
        ),
      );

      const waccParam = num(params.wacc);
      const currentPrice = num(params.currentPrice);
      const marketCap = num(params.marketCap);
      let shares = num(params.sharesOutstanding);
      if ((shares == null || shares <= 0) && marketCap && currentPrice && currentPrice > 0) {
        shares = marketCap / currentPrice;
      }

      // Base WACC: prefer compute_wacc, then compute_dcf's discountRate, else default.
      const baseWacc = waccParam ?? dcfDiscount ?? 0.1;

      // available=false if base fcf missing OR (wacc and discountRate both missing).
      if (fcf == null) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Free cash flow unavailable from upstream DCF - cannot run sensitivity",
            symbol,
          } satisfies DcfSensitivityResult,
        };
      }
      if (waccParam == null && dcfDiscount == null) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Neither WACC nor a DCF discount rate available - cannot vary the discount axis",
            symbol,
          } satisfies DcfSensitivityResult,
        };
      }
      if (shares == null || shares <= 0) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Shares outstanding unavailable (and not derivable from market cap / price)",
            symbol,
          } satisfies DcfSensitivityResult,
        };
      }

      // ── Axes ──
      // Discount-rate (WACC) axis: base +/- 1.5pp in 0.5pp steps → 7 points.
      const discountRateAxis: number[] = [];
      for (let pp = -1.5; pp <= 1.5 + 1e-9; pp += 0.5) {
        const w = round(baseWacc + pp / 100, 5);
        if (w > 0) discountRateAxis.push(w);
      }

      // Terminal-growth axis: {base-1pp, base, base+1pp}.
      const terminalGrowthAxis = [
        round(baseTerminalGrowth - 0.01, 5),
        round(baseTerminalGrowth, 5),
        round(baseTerminalGrowth + 0.01, 5),
      ];

      // FCF (stage-1) growth axis: {base-2pp, base, base+2pp}, floored at 0.
      const fcfGrowthAxis = [
        round(Math.max(0, baseGrowth - 0.02), 5),
        round(baseGrowth, 5),
        round(baseGrowth + 0.02, 5),
      ];

      const upsidePct = (iv: number): number =>
        currentPrice && currentPrice > 0
          ? round(((iv - currentPrice) / currentPrice) * 100, 1)
          : 0;

      const buildCell = (
        wacc: number,
        variable: number,
        growth: number,
        terminalGrowth: number,
      ): DcfSensitivityCell => {
        const iv = dcfPerShare(
          fcf,
          growth,
          terminalGrowth,
          wacc,
          projectionYears,
          shares,
        );
        const valid = iv != null && Number.isFinite(iv);
        return {
          discountRate: round(wacc, 5),
          variable: round(variable, 5),
          intrinsicValue: valid ? round(iv as number, 2) : 0,
          upside: valid ? upsidePct(iv as number) : 0,
          valid,
        };
      };

      // ── Grid A: WACC x terminal growth ──
      const matrixA: DcfSensitivityCell[][] = discountRateAxis.map((wacc) =>
        terminalGrowthAxis.map((tg) =>
          buildCell(wacc, tg, baseGrowth, tg),
        ),
      );

      // ── Grid B: WACC x FCF growth ──
      const matrixB: DcfSensitivityCell[][] = discountRateAxis.map((wacc) =>
        fcfGrowthAxis.map((g) =>
          buildCell(wacc, g, g, baseTerminalGrowth),
        ),
      );

      // Base-case intrinsic value (reconciles with compute_dcf).
      const baseIv = dcfPerShare(
        fcf,
        baseGrowth,
        baseTerminalGrowth,
        baseWacc,
        projectionYears,
        shares,
      );
      if (baseIv == null || !Number.isFinite(baseIv)) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Base DCF undefined (discount rate not greater than terminal growth)",
            symbol,
          } satisfies DcfSensitivityResult,
        };
      }
      const intrinsicValue = round(baseIv, 2);

      // Fair value range across all valid cells in both grids.
      const validValues: number[] = [];
      for (const row of matrixA)
        for (const c of row) if (c.valid) validValues.push(c.intrinsicValue);
      for (const row of matrixB)
        for (const c of row) if (c.valid) validValues.push(c.intrinsicValue);

      const minVal = validValues.length ? Math.min(...validValues) : intrinsicValue;
      const maxVal = validValues.length ? Math.max(...validValues) : intrinsicValue;
      const fairValueRange = {
        min: round(minVal, 2),
        max: round(maxVal, 2),
      };

      const rangeWidthPercent =
        intrinsicValue !== 0
          ? round(((maxVal - minVal) / Math.abs(intrinsicValue)) * 100, 1)
          : 0;

      const upside = upsidePct(intrinsicValue);
      const marginOfSafety =
        intrinsicValue !== 0
          ? round(((intrinsicValue - (currentPrice ?? 0)) / intrinsicValue) * 100, 1)
          : 0;

      // ── Flags (observations only) ──
      const flags: string[] = [];
      if (rangeWidthPercent > 80) {
        flags.push(
          `Intrinsic value is extremely sensitive to assumptions - fair value swings ${rangeWidthPercent.toFixed(0)}% across the grid; treat any single estimate with caution`,
        );
      } else if (rangeWidthPercent > 40) {
        flags.push(
          `Intrinsic value is moderately sensitive to assumptions - ${rangeWidthPercent.toFixed(0)}% spread between low and high cells`,
        );
      } else {
        flags.push(
          `Intrinsic value is relatively stable across the assumption grid (${rangeWidthPercent.toFixed(0)}% spread)`,
        );
      }

      if (currentPrice && currentPrice > 0) {
        if (currentPrice > maxVal) {
          flags.push(
            "Current price sits above the entire DCF fair-value range - even optimistic assumptions do not reach it",
          );
        } else if (currentPrice < minVal) {
          flags.push(
            "Current price sits below the entire DCF fair-value range - even conservative assumptions exceed it",
          );
        } else {
          flags.push(
            "Current price falls within the DCF fair-value range under these assumptions",
          );
        }
      }

      // Note any cells skipped because WACC <= terminal growth (model undefined).
      const skipped =
        matrixA.flat().filter((c) => !c.valid).length +
        matrixB.flat().filter((c) => !c.valid).length;
      if (skipped > 0) {
        flags.push(
          `${skipped} grid cell(s) omitted where discount rate did not exceed terminal growth (DCF undefined)`,
        );
      }

      const result: DcfSensitivityResult = {
        available: true,
        symbol: symbol || undefined,
        intrinsicValue,
        currentPrice: currentPrice ?? undefined,
        upside,
        marginOfSafety,
        base: {
          discountRate: round(baseWacc, 5),
          terminalGrowthRate: round(baseTerminalGrowth, 5),
          fcfGrowthRate: round(baseGrowth, 5),
          fcf: round(fcf, 2),
          projectionYears,
          sharesOutstanding: Math.round(shares),
        },
        discountRateAxis,
        terminalGrowthAxis,
        fcfGrowthAxis,
        matrixA,
        matrixB,
        fairValueRange,
        rangeWidthPercent,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `DCF sensitivity computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
