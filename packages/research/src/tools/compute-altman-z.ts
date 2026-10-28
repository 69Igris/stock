/**
 * Altman Z″-Score (emerging-markets variant)
 *
 * A financial-distress / solvency score. The Z″ model drops the market-value
 * term of the original Z-score (so it works for any company without a live
 * market cap) and re-weights for emerging markets:
 *
 *   Z″ = 3.25 + 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
 *     X1 = working capital / total assets
 *     X2 = retained earnings / total assets
 *     X3 = EBIT / total assets
 *     X4 = book value of equity / total liabilities
 *
 * Zones: > 2.6 safe · 1.1–2.6 grey · < 1.1 distress.
 *
 * PURE compute tool: reads the latest annual figures from params (injected by
 * the executor from upstream fetch results). The composite is meaningless
 * without all four terms, so if any term's inputs are missing the tool degrades
 * to available:false rather than reporting a partial/guessed score.
 *
 * SEBI: emits the score + zone + component breakdown only. No buy/sell/hold.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

function n(v: unknown): number | undefined {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : undefined;
}

export const computeAltmanZTool: ResearchToolDef = {
  name: "compute_altman_z",
  description:
    "Compute the Altman Z″-Score (emerging-markets financial-distress model) from the latest balance sheet + EBIT; reports a safe/grey/distress zone with no recommendation",
  category: "computation",
  parameters: {
    currentAssets: {
      type: "number",
      description: "Latest total current assets",
    },
    currentLiabilities: {
      type: "number",
      description: "Latest total current liabilities",
    },
    totalAssets: { type: "number", description: "Latest total assets" },
    retainedEarnings: {
      type: "number",
      description: "Latest retained earnings",
    },
    ebit: {
      type: "number",
      description: "Latest EBIT (operating income)",
    },
    totalEquity: {
      type: "number",
      description: "Latest total shareholders' equity (book value)",
    },
    totalLiabilities: {
      type: "number",
      description: "Latest total liabilities",
    },
    symbol: { type: "string", description: "Instrument symbol (for labeling)" },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string"
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const ca = n(params.currentAssets);
      const cl = n(params.currentLiabilities);
      const ta = n(params.totalAssets);
      const re = n(params.retainedEarnings);
      const ebit = n(params.ebit);
      const eq = n(params.totalEquity);
      const tl = n(params.totalLiabilities);

      // Each term needs its inputs + a non-zero denominator.
      const x1 =
        ca !== undefined && cl !== undefined && ta ? (ca - cl) / ta : undefined;
      const x2 = re !== undefined && ta ? re / ta : undefined;
      const x3 = ebit !== undefined && ta ? ebit / ta : undefined;
      const x4 = eq !== undefined && tl ? eq / tl : undefined;

      const components = [
        {
          key: "working_capital_to_assets",
          label: "Working capital / total assets",
          value: x1,
          weight: 6.56,
        },
        {
          key: "retained_earnings_to_assets",
          label: "Retained earnings / total assets",
          value: x2,
          weight: 3.26,
        },
        {
          key: "ebit_to_assets",
          label: "EBIT / total assets",
          value: x3,
          weight: 6.72,
        },
        {
          key: "equity_to_liabilities",
          label: "Book equity / total liabilities",
          value: x4,
          weight: 1.05,
        },
      ];

      const missing = components.filter((c) => c.value === undefined);
      if (missing.length > 0) {
        return {
          success: true,
          data: {
            available: false,
            symbol,
            reason: `Altman Z″ needs all four terms; missing inputs for: ${missing
              .map((c) => c.label)
              .join(", ")}`,
            components,
          },
        };
      }

      const z =
        3.25 +
        components.reduce((s, c) => s + c.weight * (c.value as number), 0);
      const zone = z > 2.6 ? "safe" : z >= 1.1 ? "grey" : "distress";

      const flags: string[] = [];
      if (zone === "distress") {
        flags.push(
          `Z″ ${z.toFixed(2)} is in the distress zone (< 1.1) — elevated financial-distress risk on this model`,
        );
      } else if (zone === "grey") {
        flags.push(
          `Z″ ${z.toFixed(2)} is in the grey zone (1.1–2.6) — inconclusive on this model`,
        );
      } else {
        flags.push(
          `Z″ ${z.toFixed(2)} is in the safe zone (> 2.6) on this model`,
        );
      }

      return {
        success: true,
        data: {
          available: true,
          symbol,
          score: Math.round(z * 100) / 100,
          zone,
          model: "Altman Z″ (emerging markets)",
          scale: "> 2.6 safe · 1.1–2.6 grey · < 1.1 distress",
          components: components.map((c) => ({
            key: c.key,
            label: c.label,
            value: Math.round((c.value as number) * 1000) / 1000,
            weight: c.weight,
          })),
          flags,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Altman Z-Score failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
