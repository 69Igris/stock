/**
 * Accounting Quality Analysis
 *
 * Computes Beneish M-Score (earnings manipulation probability)
 * and Altman Z-Score (bankruptcy risk). Flags red flags in
 * receivables growth, inventory buildup, depreciation changes.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface AccountingQualityResult {
  mScore: number;
  mScoreVerdict: "unlikely" | "possible" | "likely";
  zScore: number;
  zScoreVerdict: "safe" | "grey" | "distress";
  flags: string[];
  overallQuality: "good" | "warning" | "red_flag";
}

export const computeAccountingQualityTool: ResearchToolDef = {
  name: "compute_accounting_quality",
  description:
    "Compute Beneish M-Score (earnings manipulation) and Altman Z-Score (bankruptcy risk)",
  category: "computation",
  parameters: {
    // Income statement
    revenue: {
      type: "number",
      description: "Current year revenue",
      required: true,
    },
    prevRevenue: {
      type: "number",
      description: "Previous year revenue",
      required: true,
    },
    grossProfit: { type: "number", description: "Current gross profit" },
    prevGrossProfit: { type: "number", description: "Previous gross profit" },
    netIncome: {
      type: "number",
      description: "Current net income",
      required: true,
    },
    prevNetIncome: { type: "number", description: "Previous net income" },
    operatingIncome: { type: "number", description: "Operating income (EBIT)" },
    // Balance sheet
    totalAssets: {
      type: "number",
      description: "Current total assets",
      required: true,
    },
    prevTotalAssets: { type: "number", description: "Previous total assets" },
    currentAssets: { type: "number", description: "Current assets" },
    currentLiabilities: { type: "number", description: "Current liabilities" },
    totalLiabilities: { type: "number", description: "Total liabilities" },
    receivables: { type: "number", description: "Current accounts receivable" },
    prevReceivables: {
      type: "number",
      description: "Previous accounts receivable",
    },
    inventory: { type: "number", description: "Current inventory" },
    prevInventory: { type: "number", description: "Previous inventory" },
    retainedEarnings: { type: "number", description: "Retained earnings" },
    // Cash flow
    operatingCashFlow: { type: "number", description: "Operating cash flow" },
    depreciation: { type: "number", description: "Depreciation current year" },
    prevDepreciation: {
      type: "number",
      description: "Depreciation previous year",
    },
    // Market
    marketCap: { type: "number", description: "Market capitalization" },
  },
  execute: async (params): Promise<ToolOutput> => {
    const revenue = params.revenue as number;
    const prevRevenue = params.prevRevenue as number;
    const netIncome = params.netIncome as number;
    const totalAssets = params.totalAssets as number;

    if (!revenue || !prevRevenue || netIncome == null || !totalAssets) {
      return {
        success: false,
        error: "revenue, prevRevenue, netIncome, and totalAssets are required",
      };
    }

    try {
      const flags: string[] = [];
      const prevTotalAssets = (params.prevTotalAssets as number) || totalAssets;
      const receivables = (params.receivables as number) || 0;
      const prevReceivables = (params.prevReceivables as number) || receivables;
      const grossProfit = (params.grossProfit as number) || 0;
      const prevGrossProfit = (params.prevGrossProfit as number) || grossProfit;
      const depreciation = (params.depreciation as number) || 0;
      const prevDepreciation =
        (params.prevDepreciation as number) || depreciation;
      const operatingCashFlow = (params.operatingCashFlow as number) || 0;
      const inventory = (params.inventory as number) || 0;
      const prevInventory = (params.prevInventory as number) || inventory;
      const currentAssets = (params.currentAssets as number) || 0;
      const currentLiabilities = (params.currentLiabilities as number) || 1;
      const totalLiabilities = (params.totalLiabilities as number) || 0;
      const retainedEarnings = (params.retainedEarnings as number) || 0;
      const marketCap = (params.marketCap as number) || 0;
      const operatingIncome = (params.operatingIncome as number) || netIncome;

      // === Beneish M-Score ===
      // DSRI: Days Sales in Receivables Index
      const dsri =
        prevRevenue > 0 && revenue > 0
          ? receivables / revenue / (prevReceivables / prevRevenue || 1)
          : 1;

      // GMI: Gross Margin Index
      const prevGM = prevRevenue > 0 ? prevGrossProfit / prevRevenue : 0;
      const currGM = revenue > 0 ? grossProfit / revenue : 0;
      const gmi = currGM > 0 ? prevGM / currGM : 1;

      // AQI: Asset Quality Index (non-current assets / total assets ratio change)
      const currAQ = totalAssets > 0 ? 1 - currentAssets / totalAssets : 0;
      const prevAQ =
        prevTotalAssets > 0 ? 1 - currentAssets / prevTotalAssets : 0;
      const aqi = prevAQ > 0 ? currAQ / prevAQ : 1;

      // SGI: Sales Growth Index
      const sgi = prevRevenue > 0 ? revenue / prevRevenue : 1;

      // DEPI: Depreciation Index
      const prevDepRate =
        prevTotalAssets > 0 ? prevDepreciation / prevTotalAssets : 0;
      const currDepRate = totalAssets > 0 ? depreciation / totalAssets : 0;
      const depi = currDepRate > 0 ? prevDepRate / currDepRate : 1;

      // TATA: Total Accruals to Total Assets
      const tata =
        totalAssets > 0 ? (netIncome - operatingCashFlow) / totalAssets : 0;

      // Beneish M-Score formula
      const mScore =
        -4.84 +
        0.92 * dsri +
        0.528 * gmi +
        0.404 * aqi +
        0.892 * sgi +
        0.115 * depi -
        0.172 * 1 + // SGAI simplified to 1
        4.679 * tata -
        0.327 * 1; // LVGI simplified to 1

      const mScoreRounded = Math.round(mScore * 100) / 100;

      let mScoreVerdict: AccountingQualityResult["mScoreVerdict"] = "unlikely";
      if (mScore > -1.78) {
        mScoreVerdict = "likely";
        flags.push(
          `Beneish M-Score (${mScoreRounded}) above -1.78 - elevated probability of earnings manipulation`,
        );
      } else if (mScore > -2.22) {
        mScoreVerdict = "possible";
        flags.push(
          `Beneish M-Score (${mScoreRounded}) in grey zone - warrants scrutiny`,
        );
      }

      // === Altman Z-Score ===
      const X1 =
        totalAssets > 0
          ? (currentAssets - currentLiabilities) / totalAssets
          : 0;
      const X2 = totalAssets > 0 ? retainedEarnings / totalAssets : 0;
      const X3 = totalAssets > 0 ? operatingIncome / totalAssets : 0;
      const X4 =
        totalLiabilities > 0 && marketCap > 0
          ? marketCap / totalLiabilities
          : 1;
      const X5 = totalAssets > 0 ? revenue / totalAssets : 0;

      const zScore = 1.2 * X1 + 1.4 * X2 + 3.3 * X3 + 0.6 * X4 + 1.0 * X5;
      const zScoreRounded = Math.round(zScore * 100) / 100;

      let zScoreVerdict: AccountingQualityResult["zScoreVerdict"] = "safe";
      if (zScore < 1.81) {
        zScoreVerdict = "distress";
        flags.push(
          `Altman Z-Score (${zScoreRounded}) below 1.81 - high bankruptcy risk`,
        );
      } else if (zScore < 2.99) {
        zScoreVerdict = "grey";
        flags.push(
          `Altman Z-Score (${zScoreRounded}) in grey zone (1.81-2.99)`,
        );
      }

      // === Additional red flag checks ===
      if (receivables > 0 && prevReceivables > 0) {
        const recGrowth = (receivables - prevReceivables) / prevReceivables;
        const revGrowth =
          prevRevenue > 0 ? (revenue - prevRevenue) / prevRevenue : 0;
        if (recGrowth > revGrowth * 1.5 && recGrowth > 0.1) {
          flags.push(
            `Receivables growing ${(recGrowth * 100).toFixed(0)}% vs revenue ${(revGrowth * 100).toFixed(0)}% - potential channel stuffing`,
          );
        }
      }

      if (inventory > 0 && prevInventory > 0) {
        const invGrowth = (inventory - prevInventory) / prevInventory;
        const revGrowth =
          prevRevenue > 0 ? (revenue - prevRevenue) / prevRevenue : 0;
        if (invGrowth > revGrowth * 2 && invGrowth > 0.15) {
          flags.push(
            `Inventory buildup (${(invGrowth * 100).toFixed(0)}% growth) outpacing revenue - demand slowdown or obsolescence risk`,
          );
        }
      }

      // Overall quality
      let overallQuality: AccountingQualityResult["overallQuality"] = "good";
      if (mScoreVerdict === "likely" || zScoreVerdict === "distress") {
        overallQuality = "red_flag";
      } else if (
        mScoreVerdict === "possible" ||
        zScoreVerdict === "grey" ||
        flags.length >= 2
      ) {
        overallQuality = "warning";
      }

      const result: AccountingQualityResult = {
        mScore: mScoreRounded,
        mScoreVerdict,
        zScore: zScoreRounded,
        zScoreVerdict,
        flags,
        overallQuality,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Accounting quality analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
