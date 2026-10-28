/**
 * Beneish M-Score (earnings-manipulation likelihood)
 *
 * An 8-variable forensic model that estimates the likelihood a company has
 * manipulated its earnings. Each variable compares the latest annual period to
 * the prior one, so it needs two years of statements.
 *
 *   M = -4.84 + 0.92·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
 *           + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
 *
 * Rule of thumb: M > -1.78 → elevated manipulation likelihood; M < -2.22 → low.
 *
 * PURE compute tool: reads annual arrays (oldest→newest) from params, injected
 * by the executor from upstream fetch results. The composite is meaningless
 * without all 8 variables, so if any can't be computed the tool degrades to
 * available:false rather than reporting a partial/guessed score.
 *
 * SEBI: emits the score + the 8 component ratios + flags only. No buy/sell/hold.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

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

const def = (x: number | undefined): x is number => x !== undefined;
const ratio = (a?: number, b?: number): number | undefined =>
  def(a) && def(b) && b !== 0 ? a / b : undefined;

export const computeBeneishMTool: ResearchToolDef = {
  name: "compute_beneish_m",
  description:
    "Compute the Beneish M-Score (8-variable earnings-manipulation model) from two years of statements; flags manipulation likelihood with no recommendation",
  category: "computation",
  parameters: {
    historicalReceivables: {
      type: "array",
      description: "Annual net receivables, oldest→newest",
    },
    historicalRevenue: {
      type: "array",
      description: "Annual revenue, oldest→newest",
    },
    historicalGrossProfit: {
      type: "array",
      description: "Annual gross profit, oldest→newest",
    },
    historicalCurrentAssets: {
      type: "array",
      description: "Annual current assets, oldest→newest",
    },
    historicalPPE: {
      type: "array",
      description: "Annual property, plant & equipment, oldest→newest",
    },
    historicalTotalAssets: {
      type: "array",
      description: "Annual total assets, oldest→newest",
    },
    historicalDepreciation: {
      type: "array",
      description: "Annual depreciation, oldest→newest",
    },
    historicalSGA: {
      type: "array",
      description: "Annual SG&A expense, oldest→newest",
    },
    historicalTotalLiabilities: {
      type: "array",
      description: "Annual total liabilities, oldest→newest",
    },
    historicalNetIncome: {
      type: "array",
      description: "Annual net income, oldest→newest",
    },
    historicalOperatingCashFlow: {
      type: "array",
      description: "Annual operating cash flow, oldest→newest",
    },
    symbol: { type: "string", description: "Instrument symbol (for labeling)" },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string"
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const [recvP, recvC] = lastTwo(toNumArr(params.historicalReceivables));
      const [salesP, salesC] = lastTwo(toNumArr(params.historicalRevenue));
      const [gpP, gpC] = lastTwo(toNumArr(params.historicalGrossProfit));
      const [caP, caC] = lastTwo(toNumArr(params.historicalCurrentAssets));
      const [ppeP, ppeC] = lastTwo(toNumArr(params.historicalPPE));
      const [taP, taC] = lastTwo(toNumArr(params.historicalTotalAssets));
      const [depP, depC] = lastTwo(toNumArr(params.historicalDepreciation));
      const [sgaP, sgaC] = lastTwo(toNumArr(params.historicalSGA));
      const [tlP, tlC] = lastTwo(toNumArr(params.historicalTotalLiabilities));
      const [, niC] = lastTwo(toNumArr(params.historicalNetIncome));
      const [, cfoC] = lastTwo(toNumArr(params.historicalOperatingCashFlow));

      // DSRI — days sales in receivables index
      const DSRI = ratio(ratio(recvC, salesC), ratio(recvP, salesP));
      // GMI — gross margin index (prior / current; >1 = deteriorating margin)
      const GMI = ratio(ratio(gpP, salesP), ratio(gpC, salesC));
      // AQI — asset quality index
      const aqC =
        def(caC) && def(ppeC) && taC ? 1 - (caC + ppeC) / taC : undefined;
      const aqP =
        def(caP) && def(ppeP) && taP ? 1 - (caP + ppeP) / taP : undefined;
      const AQI = ratio(aqC, aqP);
      // SGI — sales growth index
      const SGI = ratio(salesC, salesP);
      // DEPI — depreciation index (prior rate / current rate)
      const depRateC =
        def(depC) && def(ppeC) && depC + ppeC !== 0
          ? depC / (depC + ppeC)
          : undefined;
      const depRateP =
        def(depP) && def(ppeP) && depP + ppeP !== 0
          ? depP / (depP + ppeP)
          : undefined;
      const DEPI = ratio(depRateP, depRateC);
      // SGAI — SG&A index
      const SGAI = ratio(ratio(sgaC, salesC), ratio(sgaP, salesP));
      // TATA — total accruals to total assets
      const TATA =
        def(niC) && def(cfoC) && taC ? (niC - cfoC) / taC : undefined;
      // LVGI — leverage index
      const LVGI = ratio(ratio(tlC, taC), ratio(tlP, taP));

      const variables = [
        {
          key: "dsri",
          label: "Days Sales in Receivables Index",
          value: DSRI,
          weight: 0.92,
        },
        { key: "gmi", label: "Gross Margin Index", value: GMI, weight: 0.528 },
        { key: "aqi", label: "Asset Quality Index", value: AQI, weight: 0.404 },
        { key: "sgi", label: "Sales Growth Index", value: SGI, weight: 0.892 },
        {
          key: "depi",
          label: "Depreciation Index",
          value: DEPI,
          weight: 0.115,
        },
        {
          key: "sgai",
          label: "SG&A Index",
          value: SGAI,
          weight: -0.172,
        },
        {
          key: "tata",
          label: "Total Accruals to Total Assets",
          value: TATA,
          weight: 4.679,
        },
        { key: "lvgi", label: "Leverage Index", value: LVGI, weight: -0.327 },
      ];

      const missing = variables.filter((v) => v.value === undefined);
      if (missing.length > 0) {
        return {
          success: true,
          data: {
            available: false,
            symbol,
            reason: `Beneish M-Score needs all 8 variables (two years of statements); missing: ${missing
              .map((v) => v.label)
              .join(", ")}`,
            variables,
          },
        };
      }

      const m =
        -4.84 +
        variables.reduce((s, v) => s + v.weight * (v.value as number), 0);
      const likelihood = m > -1.78 ? "elevated" : m < -2.22 ? "low" : "grey";

      const flags: string[] = [];
      if (likelihood === "elevated") {
        flags.push(
          `M-Score ${m.toFixed(2)} is above -1.78 — the model flags an ELEVATED likelihood of earnings manipulation (a screening signal, not proof)`,
        );
      } else if (likelihood === "grey") {
        flags.push(
          `M-Score ${m.toFixed(2)} is between -2.22 and -1.78 — inconclusive on this model`,
        );
      } else {
        flags.push(
          `M-Score ${m.toFixed(2)} is below -2.22 — the model indicates a LOW likelihood of manipulation`,
        );
      }

      return {
        success: true,
        data: {
          available: true,
          symbol,
          score: Math.round(m * 100) / 100,
          likelihood,
          model: "Beneish M-Score (8-variable)",
          scale: "> -1.78 elevated likelihood · < -2.22 low likelihood",
          variables: variables.map((v) => ({
            key: v.key,
            label: v.label,
            value: Math.round((v.value as number) * 1000) / 1000,
            weight: v.weight,
          })),
          flags,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Beneish M-Score failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
