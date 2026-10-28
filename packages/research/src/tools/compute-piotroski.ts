/**
 * Piotroski F-Score (0–9)
 *
 * A 9-point checklist of fundamental health across profitability, leverage /
 * liquidity, and operating efficiency. Higher = stronger fundamentals. Each
 * criterion compares the latest annual period to the prior one, so it needs at
 * least two years of statements.
 *
 * PURE compute tool: reads everything from params (annual arrays, oldest→newest,
 * injected by the executor from upstream fetch results). Criteria whose inputs
 * are missing are marked "unavailable" (passed: null) rather than guessed, and
 * the score is reported against the number of criteria ACTUALLY evaluated — never
 * a fabricated /9.
 *
 * SEBI: emits the score + per-criterion observations only. No buy/sell/hold.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

interface PiotroskiCriterion {
  key: string;
  label: string;
  /** true = pass, false = fail, null = could not evaluate (missing inputs). */
  passed: boolean | null;
}

function toNumArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "number" ? x : Number(x)))
    .filter((n) => Number.isFinite(n));
}

/** Returns [prior, current] from an oldest→newest series. */
function lastTwo(arr: number[]): [number | undefined, number | undefined] {
  if (arr.length === 0) return [undefined, undefined];
  if (arr.length === 1) return [undefined, arr[arr.length - 1]];
  return [arr[arr.length - 2], arr[arr.length - 1]];
}

export const computePiotroskiTool: ResearchToolDef = {
  name: "compute_piotroski",
  description:
    "Compute the Piotroski F-Score (0–9 fundamental-health checklist) from two years of statements; degrades per-criterion when inputs are missing",
  category: "computation",
  parameters: {
    historicalNetIncome: {
      type: "array",
      description: "Annual net income, oldest→newest",
    },
    historicalTotalAssets: {
      type: "array",
      description: "Annual total assets, oldest→newest",
    },
    historicalOperatingCashFlow: {
      type: "array",
      description: "Annual operating cash flow, oldest→newest",
    },
    historicalTotalDebt: {
      type: "array",
      description: "Annual total (or long-term) debt, oldest→newest",
    },
    historicalCurrentAssets: {
      type: "array",
      description: "Annual current assets, oldest→newest (optional)",
    },
    historicalCurrentLiabilities: {
      type: "array",
      description: "Annual current liabilities, oldest→newest (optional)",
    },
    historicalSharesOutstanding: {
      type: "array",
      description: "Annual shares outstanding, oldest→newest (optional)",
    },
    historicalGrossProfit: {
      type: "array",
      description: "Annual gross profit, oldest→newest",
    },
    historicalRevenue: {
      type: "array",
      description: "Annual revenue, oldest→newest",
    },
    symbol: { type: "string", description: "Instrument symbol (for labeling)" },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string"
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const [niPrior, niCurr] = lastTwo(toNumArr(params.historicalNetIncome));
      const [taPrior, taCurr] = lastTwo(toNumArr(params.historicalTotalAssets));
      const [, ocfCurr] = lastTwo(toNumArr(params.historicalOperatingCashFlow));
      const [debtPrior, debtCurr] = lastTwo(
        toNumArr(params.historicalTotalDebt),
      );
      const [caPrior, caCurr] = lastTwo(
        toNumArr(params.historicalCurrentAssets),
      );
      const [clPrior, clCurr] = lastTwo(
        toNumArr(params.historicalCurrentLiabilities),
      );
      const [shPrior, shCurr] = lastTwo(
        toNumArr(params.historicalSharesOutstanding),
      );
      const [gpPrior, gpCurr] = lastTwo(toNumArr(params.historicalGrossProfit));
      const [revPrior, revCurr] = lastTwo(toNumArr(params.historicalRevenue));

      const def = (x: number | undefined): x is number => x !== undefined;
      const ratio = (a?: number, b?: number) =>
        def(a) && def(b) && b !== 0 ? a / b : undefined;

      const roaCurr = ratio(niCurr, taCurr);
      const roaPrior = ratio(niPrior, taPrior);
      const levCurr = ratio(debtCurr, taCurr);
      const levPrior = ratio(debtPrior, taPrior);
      const crCurr = ratio(caCurr, clCurr);
      const crPrior = ratio(caPrior, clPrior);
      const gmCurr = ratio(gpCurr, revCurr);
      const gmPrior = ratio(gpPrior, revPrior);
      const atCurr = ratio(revCurr, taCurr);
      const atPrior = ratio(revPrior, taPrior);

      const criteria: PiotroskiCriterion[] = [
        {
          key: "roa_positive",
          label: "ROA positive",
          passed: def(roaCurr) ? roaCurr > 0 : null,
        },
        {
          key: "cfo_positive",
          label: "Operating cash flow positive",
          passed: def(ocfCurr) ? ocfCurr > 0 : null,
        },
        {
          key: "roa_improving",
          label: "ROA improving YoY",
          passed: def(roaCurr) && def(roaPrior) ? roaCurr > roaPrior : null,
        },
        {
          key: "accruals",
          label: "Cash flow > net income (earnings quality)",
          passed: def(ocfCurr) && def(niCurr) ? ocfCurr > niCurr : null,
        },
        {
          key: "leverage_down",
          label: "Leverage (debt/assets) decreasing",
          passed: def(levCurr) && def(levPrior) ? levCurr < levPrior : null,
        },
        {
          key: "current_ratio_up",
          label: "Current ratio increasing",
          passed: def(crCurr) && def(crPrior) ? crCurr > crPrior : null,
        },
        {
          key: "no_dilution",
          label: "No share dilution",
          passed: def(shCurr) && def(shPrior) ? shCurr <= shPrior : null,
        },
        {
          key: "gross_margin_up",
          label: "Gross margin improving",
          passed: def(gmCurr) && def(gmPrior) ? gmCurr > gmPrior : null,
        },
        {
          key: "asset_turnover_up",
          label: "Asset turnover improving",
          passed: def(atCurr) && def(atPrior) ? atCurr > atPrior : null,
        },
      ];

      const evaluated = criteria.filter((c) => c.passed !== null);
      const passedCount = evaluated.filter((c) => c.passed === true).length;

      if (evaluated.length < 5) {
        return {
          success: true,
          data: {
            available: false,
            symbol,
            reason: `Insufficient statement history for the Piotroski F-Score (only ${evaluated.length}/9 criteria computable; needs ≥2 years of income, balance-sheet and cash-flow data)`,
            criteria,
          },
        };
      }

      const flags: string[] = [];
      if (passedCount <= 2) {
        flags.push(
          `Low F-Score (${passedCount}/${evaluated.length} evaluated) — weak fundamental trend across the checked criteria`,
        );
      }
      if (passedCount >= Math.min(8, evaluated.length)) {
        flags.push(
          `High F-Score (${passedCount}/${evaluated.length} evaluated) — strong fundamental improvement`,
        );
      }
      const unevaluated = criteria.filter((c) => c.passed === null);
      if (unevaluated.length > 0) {
        flags.push(
          `${unevaluated.length} of 9 criteria could not be evaluated (missing: ${unevaluated.map((c) => c.label).join(", ")})`,
        );
      }

      return {
        success: true,
        data: {
          available: true,
          symbol,
          score: passedCount,
          criteriaEvaluated: evaluated.length,
          criteriaTotal: 9,
          scale: "0–9 (higher = stronger fundamentals)",
          criteria,
          flags,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Piotroski F-Score failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
