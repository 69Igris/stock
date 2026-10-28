/**
 * ITR Schedule CG Generator
 *
 * Formats capital gains data into Schedule CG format (s111A + s112A)
 * with CSV export capability.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { ITRScheduleResult, CapitalGainsTaxResult } from "../types";

export const generateItrScheduleTool: ResearchToolDef = {
  name: "generate_itr_schedule",
  description:
    "Generate ITR Schedule CG (capital gains) with CSV export for tax filing",
  category: "computation",
  parameters: {
    capitalGains: {
      type: "object",
      description: "CapitalGainsTaxResult from compute_capital_gains_tax",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const cg = params.capitalGains as CapitalGainsTaxResult | undefined;

    if (!cg) {
      return { success: false, error: "capitalGains result is required" };
    }

    try {
      const scheduleCG: ITRScheduleResult["scheduleCG"] = {
        s111A: {
          description:
            "Short Term Capital Gains on equity shares/units where STT is paid (Section 111A)",
          stcgGains: cg.equity.stcg.net,
          stcgTax: cg.equity.stcg.tax,
        },
        s112A: {
          description:
            "Long Term Capital Gains on equity shares/units where STT is paid (Section 112A)",
          ltcgGains: cg.equity.ltcg.net,
          exemption: cg.equity.ltcg.exemption,
          taxable: cg.equity.ltcg.taxable,
          ltcgTax: cg.equity.ltcg.tax,
        },
      };

      // Build CSV
      const csvLines = [
        "Symbol,Buy Date,Sell Date,Holding Days,Buy Value,Sell Value,Gain/Loss,Type",
      ];
      for (const trade of cg.trades) {
        csvLines.push(
          [
            trade.symbol,
            trade.buyDate,
            trade.sellDate,
            trade.holdingDays,
            trade.buyValue.toFixed(2),
            trade.sellValue.toFixed(2),
            trade.gain.toFixed(2),
            trade.type,
          ].join(","),
        );
      }

      // Add summary rows
      csvLines.push("");
      csvLines.push("Summary,,,,,,");
      csvLines.push(
        `STCG (s111A),,,,,Net: ${cg.equity.stcg.net.toFixed(2)},Tax: ${cg.equity.stcg.tax.toFixed(2)}`,
      );
      csvLines.push(
        `LTCG (s112A),,,,,Net: ${cg.equity.ltcg.net.toFixed(2)},Tax: ${cg.equity.ltcg.tax.toFixed(2)}`,
      );
      csvLines.push(
        `Total,,,,,Total Tax: ${cg.totalTax.toFixed(2)},Effective Rate: ${(cg.effectiveRate * 100).toFixed(2)}%`,
      );

      const summary = [
        `FY ${cg.fy} Capital Gains Summary:`,
        `  STCG (s111A): ₹${cg.equity.stcg.net.toLocaleString("en-IN")} → Tax: ₹${cg.equity.stcg.tax.toLocaleString("en-IN")} @20%`,
        `  LTCG (s112A): ₹${cg.equity.ltcg.net.toLocaleString("en-IN")} → Exempt: ₹${cg.equity.ltcg.exemption.toLocaleString("en-IN")} → Taxable: ₹${cg.equity.ltcg.taxable.toLocaleString("en-IN")} → Tax: ₹${cg.equity.ltcg.tax.toLocaleString("en-IN")} @12.5%`,
        cg.fno.net !== 0
          ? `  F&O: ₹${cg.fno.net.toLocaleString("en-IN")} (${cg.fno.note})`
          : null,
        `  Total Tax Liability: ₹${cg.totalTax.toLocaleString("en-IN")}`,
        `  Effective Rate: ${(cg.effectiveRate * 100).toFixed(2)}%`,
        "",
        "Disclaimer: This is an estimate for informational purposes only. Consult a qualified Chartered Accountant for actual ITR filing.",
      ]
        .filter(Boolean)
        .join("\n");

      const result: ITRScheduleResult = {
        scheduleCG,
        csvData: csvLines.join("\n"),
        summary,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `ITR schedule generation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
