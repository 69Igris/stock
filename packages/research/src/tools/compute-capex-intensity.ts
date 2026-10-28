/**
 * CapEx Intensity Analysis
 *
 * Capital-expenditure intensity = |CapEx| / Revenue (latest FY).
 * Also derives the 3-5yr average intensity + trend, the reinvestment
 * rate (CapEx/OCF) and a maintenance-vs-growth signal (CapEx/Depreciation).
 *
 * PURE compute tool: no network/db/io. All inputs are injected by the
 * executor from upstream fetch results (fetch_cash_flow / fetch_income_statement).
 *
 * SEBI-safe: emits OBSERVATIONS / FLAGS / SCORE only - no buy/sell/target advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface CapexIntensityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** |CapEx| / Revenue for the latest FY (ratio, e.g. 0.12 = 12%) */
  capexIntensity: number | null;
  /** Average |CapEx|/Revenue across the available 3-5yr history */
  avgCapexIntensity: number | null;
  /** Direction of intensity over the history window */
  trend: "rising" | "stable" | "falling" | "insufficient_data";
  /** |CapEx| / Operating Cash Flow - reinvestment rate */
  capexToOCF: number | null;
  /** |CapEx| / Depreciation - <1 maintenance-ish, >1 growth capex */
  capexToDepreciation: number | null;
  /** Business capital-intensity classification */
  classification:
    | "asset-light"
    | "moderate"
    | "capital-intensive"
    | "unknown";
  /** Number of historical periods used for the average/trend */
  historyYears: number;
  qualityScore: number; // 0-100
  flags: string[];
}

export const computeCapexIntensityTool: ResearchToolDef = {
  name: "compute_capex_intensity",
  description:
    "Capital-expenditure intensity - CapEx/Revenue, trend, CapEx/OCF reinvestment rate, CapEx/Depreciation maintenance-vs-growth signal",
  category: "computation",
  parameters: {
    capitalExpenditure: {
      type: "number",
      description:
        "Latest annual CapEx (sign-agnostic; absolute value is used)",
    },
    revenue: {
      type: "number",
      description: "Latest annual revenue",
    },
    operatingCashFlow: {
      type: "number",
      description: "Latest annual operating cash flow",
    },
    depreciation: {
      type: "number",
      description:
        "Latest annual depreciation & amortization (optional; enables maintenance-vs-growth signal)",
    },
    historicalCapex: {
      type: "array",
      description:
        "Historical CapEx values, oldest to newest (sign-agnostic)",
    },
    historicalRevenue: {
      type: "array",
      description: "Historical revenue values, oldest to newest",
    },
    symbol: {
      type: "string",
      description: "Symbol for context in the result (optional)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string"
        ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
        : undefined;

    // ── Coercion helpers (graceful nullish handling) ──────────
    const toNum = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    const toNumArray = (v: unknown): number[] => {
      if (!Array.isArray(v)) return [];
      return v
        .map((x) => toNum(x))
        .filter((x): x is number => x !== null);
    };
    const round = (v: number, dp: number): number => {
      const f = 10 ** dp;
      return Math.round(v * f) / f;
    };

    const capexRaw = toNum(params.capitalExpenditure);
    const revenueRaw = toNum(params.revenue);
    const ocfRaw = toNum(params.operatingCashFlow);
    const depreciationRaw = toNum(params.depreciation);

    const capex = capexRaw !== null ? Math.abs(capexRaw) : null;
    const revenue = revenueRaw;
    const ocf = ocfRaw;
    const depreciation =
      depreciationRaw !== null ? Math.abs(depreciationRaw) : null;

    const historicalCapex = toNumArray(params.historicalCapex).map((x) =>
      Math.abs(x),
    );
    const historicalRevenue = toNumArray(params.historicalRevenue);

    // available=false only if BOTH capitalExpenditure and revenue missing.
    if (capex === null && revenue === null) {
      const result: CapexIntensityResult = {
        available: false,
        reason:
          "Neither capital expenditure nor revenue was available to compute CapEx intensity",
        symbol,
        capexIntensity: null,
        avgCapexIntensity: null,
        trend: "insufficient_data",
        capexToOCF: null,
        capexToDepreciation: null,
        classification: "unknown",
        historyYears: 0,
        qualityScore: 0,
        flags: [],
      };
      return { success: true, data: result };
    }

    try {
      const flags: string[] = [];

      // ── Latest FY intensity ─────────────────────────────────
      const capexIntensity =
        capex !== null && revenue !== null && revenue > 0
          ? round(capex / revenue, 4)
          : null;

      // ── Reinvestment rate (CapEx / OCF) ─────────────────────
      const capexToOCF =
        capex !== null && ocf !== null && ocf > 0
          ? round(capex / ocf, 4)
          : null;

      // ── Maintenance-vs-growth (CapEx / Depreciation) ────────
      const capexToDepreciation =
        capex !== null && depreciation !== null && depreciation > 0
          ? round(capex / depreciation, 4)
          : null;

      // ── Historical average intensity + trend ────────────────
      // Pair up to 5 most-recent years where both capex & revenue exist.
      const len = Math.min(historicalCapex.length, historicalRevenue.length);
      const intensitySeries: number[] = [];
      if (len > 0) {
        const start = Math.max(0, len - 5);
        for (let i = start; i < len; i++) {
          const c = historicalCapex[i]!;
          const r = historicalRevenue[i]!;
          if (r > 0) intensitySeries.push(c / r);
        }
      }
      const historyYears = intensitySeries.length;

      const avgCapexIntensity =
        historyYears > 0
          ? round(
              intensitySeries.reduce((a, b) => a + b, 0) / historyYears,
              4,
            )
          : null;

      // Trend: compare first vs last of the series with a tolerance band.
      let trend: CapexIntensityResult["trend"] = "insufficient_data";
      if (historyYears >= 3) {
        const first = intensitySeries[0]!;
        const last = intensitySeries[historyYears - 1]!;
        if (first > 0) {
          const change = (last - first) / first;
          if (change > 0.15) trend = "rising";
          else if (change < -0.15) trend = "falling";
          else trend = "stable";
        } else {
          trend = last > 0 ? "rising" : "stable";
        }
      }

      // ── Classification (uses latest, else historical average) ─
      const refIntensity =
        capexIntensity !== null ? capexIntensity : avgCapexIntensity;
      let classification: CapexIntensityResult["classification"] = "unknown";
      if (refIntensity !== null) {
        if (refIntensity < 0.05) classification = "asset-light";
        else if (refIntensity <= 0.15) classification = "moderate";
        else classification = "capital-intensive";
      }

      // ── Flags (observations only) ───────────────────────────
      if (classification === "capital-intensive" && refIntensity !== null) {
        flags.push(
          `High CapEx intensity (${(refIntensity * 100).toFixed(1)}% of revenue) - capital-intensive business`,
        );
      }
      if (classification === "asset-light" && refIntensity !== null) {
        flags.push(
          `Low CapEx intensity (${(refIntensity * 100).toFixed(1)}% of revenue) - asset-light business`,
        );
      }

      // Rising intensity with flat/declining revenue can be value-destructive.
      if (trend === "rising" && historicalRevenue.length >= 3) {
        const recentRev = historicalRevenue.slice(-3);
        const revFirst = recentRev[0]!;
        const revLast = recentRev[recentRev.length - 1]!;
        const revGrowth = revFirst > 0 ? (revLast - revFirst) / revFirst : 0;
        if (revGrowth <= 0.03) {
          flags.push(
            "CapEx intensity is rising while revenue is flat or declining - reinvestment not yet translating to growth",
          );
        }
      }

      // Reinvestment consuming most/all of operating cash flow.
      if (capexToOCF !== null && capexToOCF > 1) {
        flags.push(
          `CapEx exceeds operating cash flow (CapEx/OCF ${capexToOCF.toFixed(2)}x) - reinvestment funded beyond internal cash generation`,
        );
      } else if (capexToOCF !== null && capexToOCF > 0.7) {
        flags.push(
          `CapEx absorbs a large share of operating cash flow (CapEx/OCF ${capexToOCF.toFixed(2)}x)`,
        );
      }

      // Maintenance-vs-growth read.
      if (capexToDepreciation !== null && capexToDepreciation > 1.5) {
        flags.push(
          `CapEx well above depreciation (${capexToDepreciation.toFixed(2)}x) - growth-oriented capital spending`,
        );
      } else if (
        capexToDepreciation !== null &&
        capexToDepreciation < 0.8
      ) {
        flags.push(
          `CapEx below depreciation (${capexToDepreciation.toFixed(2)}x) - may be under-investing relative to asset base`,
        );
      }

      // ── Quality score (0-100) ───────────────────────────────
      // Heuristic: efficient, stable, internally-funded reinvestment scores higher.
      let qualityScore = 50;

      if (classification === "asset-light") qualityScore += 10;
      else if (classification === "capital-intensive") qualityScore -= 5;

      if (trend === "falling") qualityScore += 10; // improving efficiency
      else if (trend === "stable") qualityScore += 5;
      else if (trend === "rising") qualityScore -= 5;

      if (capexToOCF !== null) {
        if (capexToOCF <= 0.5) qualityScore += 15; // ample FCF after capex
        else if (capexToOCF <= 0.7) qualityScore += 5;
        else if (capexToOCF > 1) qualityScore -= 15; // capex outruns OCF
      }

      if (capexToDepreciation !== null) {
        // 1.0-1.5x = healthy growth reinvestment without overspending
        if (capexToDepreciation >= 1 && capexToDepreciation <= 1.5)
          qualityScore += 10;
        else if (capexToDepreciation < 0.8) qualityScore -= 5;
      }

      // Penalise the value-destructive combination once more.
      if (
        flags.some((f) =>
          f.includes("reinvestment not yet translating to growth"),
        )
      ) {
        qualityScore -= 10;
      }

      qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));

      const result: CapexIntensityResult = {
        available: true,
        symbol,
        capexIntensity,
        avgCapexIntensity,
        trend,
        capexToOCF,
        capexToDepreciation,
        classification,
        historyYears,
        qualityScore,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `CapEx intensity analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
