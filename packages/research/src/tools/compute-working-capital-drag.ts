/**
 * Working Capital Drag Analysis
 *
 * Working-capital efficiency and the cash impact of working-capital swings.
 * Computes DSO / DIO / DPO and the cash conversion cycle (CCC), net working
 * capital and its intensity vs revenue, and the YoY change in working capital
 * (a positive change absorbs cash = a drag). Classifies the CCC trend and
 * surfaces observation flags for a lengthening cycle or WC growing faster than
 * revenue. PURE compute - all inputs are injected from upstream fetch results.
 *
 * Inputs are sourced by the executor as follows:
 *   - revenue / costOfRevenue from fetch_income_statement.annual[last]
 *   - receivables / inventory / payables from fetch_balance_sheet.annual[last]
 *     (any of these may be absent -> the matching sub-metrics degrade to null)
 *
 * SEBI: observations / scores / flags only. No buy/sell/hold/target language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface WorkingCapitalDragResult {
  available: boolean;
  reason?: string;
  symbol?: string;

  // Days metrics (null when the required component is missing)
  dso: number | null; // Days Sales Outstanding = receivables / revenue * 365
  dio: number | null; // Days Inventory Outstanding = inventory / COGS * 365
  dpo: number | null; // Days Payable Outstanding = payables / COGS * 365
  cashConversionCycle: number | null; // DSO + DIO - DPO

  // Net working capital
  netWorkingCapital: number | null; // receivables + inventory - payables
  nwcToRevenue: number | null; // NWC / revenue (ratio)

  // Year-over-year swing (cash impact)
  changeInWorkingCapital: number | null; // current NWC - prior NWC
  changeInWCToRevenue: number | null; // changeInWC / revenue (ratio)
  cashImpact: "absorbed" | "released" | "neutral" | null; // positive change = cash absorbed = drag

  // Trend over the provided history
  cccTrend: "improving" | "stable" | "lengthening" | "unknown";

  score: number; // 0-100 (lower CCC + stable/improving = better)
  flags: string[];
}

/** Coerce an unknown param into a finite number, else null. */
function toNum(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce an unknown param into an array of finite numbers (oldest -> newest). */
function toNumArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => toNum(v))
    .filter((v): v is number => v !== null);
}

function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export const computeWorkingCapitalDragTool: ResearchToolDef = {
  name: "compute_working_capital_drag",
  description:
    "Analyze working-capital efficiency and cash drag - DSO/DIO/DPO, cash conversion cycle, NWC swing impact",
  category: "computation",
  parameters: {
    symbol: { type: "string", description: "Ticker symbol for labeling" },
    revenue: {
      type: "number",
      description: "Latest annual revenue (from fetch_income_statement)",
    },
    costOfRevenue: {
      type: "number",
      description:
        "Latest annual cost of revenue / COGS (from fetch_income_statement). Falls back to revenue for DIO/DPO if absent.",
    },
    receivables: {
      type: "number",
      description: "Latest trade receivables (from fetch_balance_sheet)",
    },
    inventory: {
      type: "number",
      description: "Latest inventory (from fetch_balance_sheet)",
    },
    payables: {
      type: "number",
      description: "Latest trade payables (from fetch_balance_sheet)",
    },
    priorReceivables: {
      type: "number",
      description: "Prior-year trade receivables (for YoY WC change)",
    },
    priorInventory: {
      type: "number",
      description: "Prior-year inventory (for YoY WC change)",
    },
    priorPayables: {
      type: "number",
      description: "Prior-year trade payables (for YoY WC change)",
    },
    historicalReceivables: {
      type: "array",
      description: "Historical receivables (oldest to newest) for trend",
    },
    historicalInventory: {
      type: "array",
      description: "Historical inventory (oldest to newest) for trend",
    },
    historicalPayables: {
      type: "array",
      description: "Historical payables (oldest to newest) for trend",
    },
    historicalRevenue: {
      type: "array",
      description: "Historical revenue (oldest to newest) for trend",
    },
    historicalCostOfRevenue: {
      type: "array",
      description: "Historical COGS (oldest to newest) for trend",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" ? params.symbol : undefined;

      const revenue = toNum(params.revenue);
      // COGS drives DIO/DPO. If absent, fall back to revenue as a conservative
      // proxy so we still produce *something* rather than nothing.
      const cogsRaw = toNum(params.costOfRevenue);
      const cogs = cogsRaw != null ? Math.abs(cogsRaw) : revenue;

      const receivables = toNum(params.receivables);
      const inventory = toNum(params.inventory);
      const payables = toNum(params.payables);

      const hasAnyComponent =
        receivables != null || inventory != null || payables != null;

      // Graceful degradation: need revenue OR at least one WC component.
      if ((revenue == null || revenue <= 0) && !hasAnyComponent) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Revenue and balance-sheet working-capital components (receivables/inventory/payables) are unavailable",
            symbol,
            dso: null,
            dio: null,
            dpo: null,
            cashConversionCycle: null,
            netWorkingCapital: null,
            nwcToRevenue: null,
            changeInWorkingCapital: null,
            changeInWCToRevenue: null,
            cashImpact: null,
            cccTrend: "unknown",
            score: 0,
            flags: [],
          } satisfies WorkingCapitalDragResult,
        };
      }

      const flags: string[] = [];

      // ── Days metrics ────────────────────────────────────────
      const dso =
        receivables != null && revenue != null && revenue > 0
          ? round((receivables / revenue) * 365, 1)
          : null;
      const dio =
        inventory != null && cogs != null && cogs > 0
          ? round((inventory / cogs) * 365, 1)
          : null;
      const dpo =
        payables != null && cogs != null && cogs > 0
          ? round((payables / cogs) * 365, 1)
          : null;

      // CCC = DSO + DIO - DPO. Only meaningful if at least DSO or DIO present.
      const cashConversionCycle =
        dso != null || dio != null
          ? round((dso ?? 0) + (dio ?? 0) - (dpo ?? 0), 1)
          : null;

      // ── Net working capital ─────────────────────────────────
      const netWorkingCapital = hasAnyComponent
        ? round((receivables ?? 0) + (inventory ?? 0) - (payables ?? 0), 2)
        : null;

      const nwcToRevenue =
        netWorkingCapital != null && revenue != null && revenue > 0
          ? round(netWorkingCapital / revenue, 4)
          : null;

      // ── YoY change in working capital ───────────────────────
      const priorReceivables = toNum(params.priorReceivables);
      const priorInventory = toNum(params.priorInventory);
      const priorPayables = toNum(params.priorPayables);
      const hasAnyPrior =
        priorReceivables != null ||
        priorInventory != null ||
        priorPayables != null;

      let changeInWorkingCapital: number | null = null;
      let changeInWCToRevenue: number | null = null;
      let cashImpact: WorkingCapitalDragResult["cashImpact"] = null;

      if (netWorkingCapital != null && hasAnyPrior) {
        const priorNWC =
          (priorReceivables ?? 0) +
          (priorInventory ?? 0) -
          (priorPayables ?? 0);
        changeInWorkingCapital = round(netWorkingCapital - priorNWC, 2);
        if (revenue != null && revenue > 0) {
          changeInWCToRevenue = round(changeInWorkingCapital / revenue, 4);
        }
        // Positive change = WC grew = cash absorbed = drag.
        if (changeInWorkingCapital > 0) cashImpact = "absorbed";
        else if (changeInWorkingCapital < 0) cashImpact = "released";
        else cashImpact = "neutral";

        if (cashImpact === "absorbed") {
          if (changeInWCToRevenue != null && changeInWCToRevenue > 0.1) {
            flags.push(
              `Working capital absorbed cash equal to ${(changeInWCToRevenue * 100).toFixed(1)}% of revenue YoY - meaningful cash drag`,
            );
          } else {
            flags.push(
              "Working capital grew YoY, absorbing cash from operations",
            );
          }
        }
      }

      // WC growing faster than revenue (uses history if available, else YoY).
      const histReceivables = toNumArray(params.historicalReceivables);
      const histInventory = toNumArray(params.historicalInventory);
      const histPayables = toNumArray(params.historicalPayables);
      const histRevenue = toNumArray(params.historicalRevenue);
      const histCogs = toNumArray(params.historicalCostOfRevenue);

      // Build a per-period NWC series and (optionally) a CCC series.
      const periods = Math.max(
        histReceivables.length,
        histInventory.length,
        histPayables.length,
      );
      const nwcSeries: number[] = [];
      const cccSeries: number[] = [];
      for (let i = 0; i < periods; i++) {
        const r = histReceivables[i];
        const inv = histInventory[i];
        const p = histPayables[i];
        if (r == null && inv == null && p == null) continue;
        nwcSeries.push((r ?? 0) + (inv ?? 0) - (p ?? 0));

        const rev = histRevenue[i];
        const cg = histCogs[i] != null ? Math.abs(histCogs[i]!) : rev;
        const periodDso =
          r != null && rev != null && rev > 0 ? (r / rev) * 365 : 0;
        const periodDio =
          inv != null && cg != null && cg > 0 ? (inv / cg) * 365 : 0;
        const periodDpo =
          p != null && cg != null && cg > 0 ? (p / cg) * 365 : 0;
        if (r != null || inv != null) {
          cccSeries.push(periodDso + periodDio - periodDpo);
        }
      }

      // ── CCC / WC trend classification ───────────────────────
      let cccTrend: WorkingCapitalDragResult["cccTrend"] = "unknown";
      if (cccSeries.length >= 3) {
        const recent = cccSeries.slice(-3);
        const first = recent[0]!;
        const last = recent[recent.length - 1]!;
        const base = Math.abs(first) > 1e-9 ? Math.abs(first) : 1;
        const delta = (last - first) / base;
        if (delta > 0.1) {
          cccTrend = "lengthening";
          flags.push(
            "Cash conversion cycle is lengthening over recent years - working capital efficiency deteriorating",
          );
        } else if (delta < -0.1) {
          cccTrend = "improving";
        } else {
          cccTrend = "stable";
        }
      }

      // WC growing faster than revenue (history-preferred).
      let wcOutpacingRevenue: boolean | null = null;
      if (
        nwcSeries.length >= 2 &&
        histRevenue.length >= 2 &&
        nwcSeries[0]! !== 0 &&
        histRevenue[0]! > 0
      ) {
        const nwcGrowth =
          (nwcSeries[nwcSeries.length - 1]! - nwcSeries[0]!) /
          Math.abs(nwcSeries[0]!);
        const revGrowth =
          (histRevenue[histRevenue.length - 1]! - histRevenue[0]!) /
          Math.abs(histRevenue[0]!);
        wcOutpacingRevenue = nwcGrowth > revGrowth + 0.05;
      } else if (
        changeInWCToRevenue != null &&
        nwcToRevenue != null &&
        nwcToRevenue !== 0
      ) {
        // Fallback: single-period YoY NWC growth vs revenue change is not
        // directly comparable, so only flag the YoY absorption above.
        wcOutpacingRevenue = null;
      }
      if (wcOutpacingRevenue === true) {
        flags.push(
          "Working capital growing faster than revenue - tying up incremental cash as the business scales",
        );
      }

      // High NWC intensity observation.
      if (nwcToRevenue != null && nwcToRevenue > 0.3) {
        flags.push(
          `Net working capital is ${(nwcToRevenue * 100).toFixed(1)}% of revenue - working-capital-heavy business model`,
        );
      } else if (nwcToRevenue != null && nwcToRevenue < 0) {
        flags.push(
          "Negative net working capital - business is funded by suppliers/customers (favorable cash dynamics)",
        );
      }

      // ── Score (0-100) ───────────────────────────────────────
      // Lower CCC + stable/improving trend + cash-light NWC = higher score.
      let score = 50;

      if (cashConversionCycle != null) {
        if (cashConversionCycle <= 0) score += 25;
        else if (cashConversionCycle <= 30) score += 18;
        else if (cashConversionCycle <= 60) score += 10;
        else if (cashConversionCycle <= 90) score += 0;
        else if (cashConversionCycle <= 120) score -= 10;
        else score -= 20;
      }

      if (nwcToRevenue != null) {
        if (nwcToRevenue < 0) score += 10;
        else if (nwcToRevenue <= 0.1) score += 8;
        else if (nwcToRevenue <= 0.2) score += 3;
        else if (nwcToRevenue <= 0.3) score -= 3;
        else score -= 10;
      }

      if (cccTrend === "improving") score += 10;
      else if (cccTrend === "lengthening") score -= 12;

      if (cashImpact === "released") score += 5;
      else if (cashImpact === "absorbed") {
        if (changeInWCToRevenue != null && changeInWCToRevenue > 0.1)
          score -= 10;
        else score -= 4;
      }

      if (wcOutpacingRevenue === true) score -= 6;

      score = Math.max(0, Math.min(100, Math.round(score)));

      const result: WorkingCapitalDragResult = {
        available: true,
        symbol,
        dso,
        dio,
        dpo,
        cashConversionCycle,
        netWorkingCapital,
        nwcToRevenue,
        changeInWorkingCapital,
        changeInWCToRevenue,
        cashImpact,
        cccTrend,
        score,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Working capital drag analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
