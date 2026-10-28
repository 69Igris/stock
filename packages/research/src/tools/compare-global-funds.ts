/**
 * Compare Global Funds - currency-normalized comparison
 *
 * Compares two or more funds (Indian or global) across key metrics
 * with currency normalization awareness.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export const compareGlobalFundsTool: ResearchToolDef = {
  name: "compare_global_funds",
  description:
    "Compare two or more funds (Indian or global) with currency-normalized metrics",
  category: "computation",
  parameters: {
    funds: {
      type: "object[]",
      description:
        "Array of fund data objects from fetch_mf_overview or fetch_global_fund",
      required: true,
    },
    baseCurrency: {
      type: "string",
      description: "Currency to normalize to (default: INR)",
      default: "INR",
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const funds = params.funds as Array<Record<string, unknown>> | undefined;
    const baseCurrency = (params.baseCurrency as string) || "INR";

    if (!funds || funds.length < 2) {
      return {
        success: false,
        error: "At least 2 funds required for comparison",
      };
    }

    try {
      const comparison = funds.map((fund) => {
        const currency = (fund.currency as string) || "INR";
        const needsConversion = currency !== baseCurrency;

        return {
          name: (fund.name as string) || (fund.symbol as string) || "Unknown",
          symbol: (fund.symbol as string) || "",
          currency,
          needsConversion,
          nav: fund.nav as number | undefined,
          expenseRatio: fund.expenseRatio as number | undefined,
          return1y: fund.return1y as number | undefined,
          return3y: fund.return3y as number | undefined,
          return5y: fund.return5y as number | undefined,
          aum:
            (fund.totalAssets as number | undefined) ||
            (fund.aum as number | undefined),
          category: fund.category as string | undefined,
          risk: fund.riskLevel as string | undefined,
          topHoldings: fund.topHoldings as unknown[] | undefined,
        };
      });

      // Find best/worst in each metric
      const metrics = [
        "expenseRatio",
        "return1y",
        "return3y",
        "return5y",
      ] as const;
      const analysis: Record<string, Record<string, string>> = {};

      for (const metric of metrics) {
        const values = comparison
          .map((f, i) => ({
            index: i,
            value: f[metric] as number | undefined,
          }))
          .filter(
            (v): v is { index: number; value: number } => v.value != null,
          );

        if (values.length > 0) {
          const isLowerBetter = metric === "expenseRatio";
          values.sort((a, b) =>
            isLowerBetter ? a.value - b.value : b.value - a.value,
          );

          analysis[metric] = {
            best: comparison[values[0]!.index]!.name,
            worst: comparison[values[values.length - 1]!.index]!.name,
          };
        }
      }

      return {
        success: true,
        data: {
          baseCurrency,
          funds: comparison,
          analysis,
          note: comparison.some((f) => f.needsConversion)
            ? `Some funds are in different currencies. Returns are in original currency - direct comparison requires FX adjustment.`
            : undefined,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Comparison failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
