/**
 * Advance Tax Computation (India)
 *
 * If total tax liability > ₹10,000, advance tax applies.
 * Quarterly installments: 15% (Jun), 45% (Sep), 75% (Dec), 100% (Mar).
 * Interest under S234C for shortfall.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { AdvanceTaxResult } from "../types";

const ADVANCE_TAX_THRESHOLD = 10000; // ₹10,000
const INTEREST_RATE_234C = 0.01; // 1% per month

const INSTALLMENTS = [
  { quarter: "Q1 (Jun 15)", dueDate: "06-15", cumulativePercent: 15 },
  { quarter: "Q2 (Sep 15)", dueDate: "09-15", cumulativePercent: 45 },
  { quarter: "Q3 (Dec 15)", dueDate: "12-15", cumulativePercent: 75 },
  { quarter: "Q4 (Mar 15)", dueDate: "03-15", cumulativePercent: 100 },
];

export const computeAdvanceTaxTool: ResearchToolDef = {
  name: "compute_advance_tax",
  description:
    "Compute advance tax installments and S234C interest for shortfall",
  category: "computation",
  parameters: {
    totalEstimatedTax: {
      type: "number",
      description: "Total estimated tax liability for the year",
      required: true,
    },
    paidInstallments: {
      type: "array",
      description:
        "Array of amounts already paid for each quarter [Q1, Q2, Q3, Q4]",
      default: [],
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const totalTax = params.totalEstimatedTax as number;
    const paid = (params.paidInstallments as number[]) || [0, 0, 0, 0];

    if (totalTax == null) {
      return { success: false, error: "totalEstimatedTax is required" };
    }

    try {
      const isApplicable = totalTax > ADVANCE_TAX_THRESHOLD;

      const installments: AdvanceTaxResult["installments"] = INSTALLMENTS.map(
        (inst, i) => {
          const amount = Math.round(totalTax * (inst.cumulativePercent / 100));
          const paidAmount = paid[i] || 0;
          const cumulativePaid = paid
            .slice(0, i + 1)
            .reduce((s, p) => s + p, 0);
          const shortfall = Math.max(0, amount - cumulativePaid);

          return {
            quarter: inst.quarter,
            dueDate: inst.dueDate,
            cumulativePercent: inst.cumulativePercent,
            amount,
            paid: paidAmount,
            shortfall,
          };
        },
      );

      // S234C interest: 1% per month on shortfall for each quarter
      let interestU234C = 0;
      if (isApplicable) {
        const monthsAfter = [9, 6, 3, 0]; // months remaining in FY
        for (let i = 0; i < installments.length; i++) {
          const shortfall = installments[i]!.shortfall || 0;
          if (shortfall > 0) {
            interestU234C += Math.round(
              shortfall * INTEREST_RATE_234C * monthsAfter[i]!,
            );
          }
        }
      }

      const result: AdvanceTaxResult = {
        totalEstimatedTax: totalTax,
        isApplicable,
        installments,
        interestU234C,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Advance tax computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
