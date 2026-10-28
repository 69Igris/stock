/**
 * Payout Coverage Analysis (Dividend & Buyback Sustainability)
 *
 * Computes payout ratio, FCF payout, dividend coverage, buyback yield, and
 * total shareholder yield to judge how sustainable cash returns to shareholders
 * are. Outputs observations / scores / flags only (SEBI: no buy/sell advice).
 *
 * PURE compute tool - reads everything from params (injected by the executor
 * from upstream fetch results). No network / db / io.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface PayoutCoverageResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** dividendsPaid / netIncome (or dps / eps), 0-1+ */
  payoutRatio: number | null;
  /** dividendsPaid / FCF (>1 = paying more cash than generated) */
  fcfPayout: number | null;
  /** netIncome / dividendsPaid (higher = safer) */
  dividendCoverage: number | null;
  /** buybacks / marketCap, 0-1 (null if unavailable) */
  buybackYield: number | null;
  /** (dividends + buybacks) / marketCap, 0-1 (null if unavailable) */
  totalShareholderYield: number | null;
  /** Resolved dividend yield (dps / currentPrice) if derivable */
  dividendYield: number | null;
  verdict: "safe" | "moderate" | "at_risk" | "unknown";
  /** 0-100, higher = more sustainable */
  sustainabilityScore: number;
  flags: string[];
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const computePayoutCoverageTool: ResearchToolDef = {
  name: "compute_payout_coverage",
  description:
    "Assess dividend & buyback sustainability - payout ratio, FCF payout, coverage, shareholder yield",
  category: "computation",
  parameters: {
    symbol: { type: "string", description: "Ticker symbol (for labeling)" },
    dividendsPaid: {
      type: "number",
      description:
        "Total annual dividends paid (absolute amount; positive). From cash flow statement",
    },
    dps: {
      type: "number",
      description: "Dividend per share (alternative to dividendsPaid)",
    },
    netIncome: {
      type: "number",
      description: "Latest annual net income (profit after tax)",
      required: true,
    },
    eps: {
      type: "number",
      description: "Earnings per share (used with dps when totals absent)",
    },
    freeCashFlow: {
      type: "number",
      description: "Latest annual free cash flow",
    },
    buybacks: {
      type: "number",
      description: "Annual share buyback / repurchase amount (optional)",
    },
    marketCap: { type: "number", description: "Current market capitalization" },
    currentPrice: {
      type: "number",
      description: "Current share price (used to derive yield from dps)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" && params.symbol
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const dividendsPaidRaw = toNum(params.dividendsPaid);
      const dps = toNum(params.dps);
      const netIncome = toNum(params.netIncome);
      const eps = toNum(params.eps);
      const freeCashFlow = toNum(params.freeCashFlow);
      const buybacks = toNum(params.buybacks);
      const marketCap = toNum(params.marketCap);
      const currentPrice = toNum(params.currentPrice);

      // Normalise dividends to a positive magnitude (cash flow often signs it negative).
      const dividendsPaid =
        dividendsPaidRaw !== null ? Math.abs(dividendsPaidRaw) : null;
      const dpsAbs = dps !== null ? Math.abs(dps) : null;

      // Graceful degradation: need a dividend signal AND net income.
      if ((dividendsPaid === null && dpsAbs === null) || netIncome === null) {
        const missing: string[] = [];
        if (dividendsPaid === null && dpsAbs === null)
          missing.push("dividendsPaid/dps");
        if (netIncome === null) missing.push("netIncome");
        const result: PayoutCoverageResult = {
          available: false,
          reason: `Missing required inputs: ${missing.join(", ")}`,
          symbol,
          payoutRatio: null,
          fcfPayout: null,
          dividendCoverage: null,
          buybackYield: null,
          totalShareholderYield: null,
          dividendYield: null,
          verdict: "unknown",
          sustainabilityScore: 0,
          flags: [],
        };
        return { success: true, data: result };
      }

      const flags: string[] = [];

      // ── Payout ratio: prefer totals, fall back to per-share ──
      let payoutRatio: number | null = null;
      if (dividendsPaid !== null && netIncome !== 0) {
        payoutRatio = dividendsPaid / netIncome;
      } else if (dpsAbs !== null && eps !== null && eps !== 0) {
        payoutRatio = dpsAbs / eps;
      }
      if (payoutRatio !== null) payoutRatio = round(payoutRatio, 4);

      // ── FCF payout: dividendsPaid / FCF (>1 = unsustainable) ──
      let fcfPayout: number | null = null;
      if (dividendsPaid !== null && freeCashFlow !== null && freeCashFlow !== 0) {
        fcfPayout = round(dividendsPaid / freeCashFlow, 4);
      }

      // ── Dividend coverage: netIncome / dividendsPaid ──
      let dividendCoverage: number | null = null;
      if (dividendsPaid !== null && dividendsPaid !== 0) {
        dividendCoverage = round(netIncome / dividendsPaid, 2);
      }

      // ── Buyback yield & total shareholder yield ──
      let buybackYield: number | null = null;
      let totalShareholderYield: number | null = null;
      if (marketCap !== null && marketCap > 0) {
        if (buybacks !== null) {
          buybackYield = round(Math.abs(buybacks) / marketCap, 4);
        }
        if (dividendsPaid !== null) {
          const totalReturn = dividendsPaid + Math.abs(buybacks ?? 0);
          totalShareholderYield = round(totalReturn / marketCap, 4);
        }
      }

      // ── Dividend yield (dps / price) when derivable ──
      let dividendYield: number | null = null;
      if (dpsAbs !== null && currentPrice !== null && currentPrice > 0) {
        dividendYield = round(dpsAbs / currentPrice, 4);
      }

      // ── Flags & verdict ──
      let verdict: PayoutCoverageResult["verdict"] = "moderate";

      if (netIncome <= 0) {
        verdict = "at_risk";
        flags.push(
          "Dividends paid despite non-positive net income - funded by reserves or debt, not earnings",
        );
      }
      if (fcfPayout !== null && fcfPayout > 1) {
        verdict = "at_risk";
        flags.push(
          `FCF payout above 100% (${(fcfPayout * 100).toFixed(0)}%) - paying out more cash than generated, unsustainable without buffers`,
        );
      }
      if (freeCashFlow !== null && freeCashFlow < 0 && dividendsPaid !== null) {
        verdict = "at_risk";
        flags.push(
          "Negative free cash flow while paying dividends - cash returns not self-funded",
        );
      }
      if (payoutRatio !== null && payoutRatio > 0.9) {
        verdict = "at_risk";
        flags.push(
          `Very high payout ratio (${(payoutRatio * 100).toFixed(0)}%) - little earnings retained for growth or buffer`,
        );
      } else if (payoutRatio !== null && payoutRatio > 0.6 && verdict !== "at_risk") {
        verdict = "moderate";
        flags.push(
          `Elevated payout ratio (${(payoutRatio * 100).toFixed(0)}%) - limited cushion if earnings dip`,
        );
      }

      // Promote to "safe" only when the conservative thresholds all hold.
      const payoutSafe = payoutRatio !== null && payoutRatio < 0.6;
      const fcfSafe = fcfPayout === null || fcfPayout < 0.8;
      if (verdict !== "at_risk" && payoutSafe && fcfSafe && netIncome > 0) {
        verdict = "safe";
      }

      if (dividendCoverage !== null && dividendCoverage < 1 && netIncome > 0) {
        flags.push(
          `Dividend coverage below 1x (${dividendCoverage.toFixed(2)}x) - dividends exceed current-year earnings`,
        );
      }
      if (buybackYield !== null && buybackYield > 0) {
        flags.push(
          `Buybacks add ${(buybackYield * 100).toFixed(2)}% to shareholder yield`,
        );
      }

      // ── Sustainability score (0-100) ──
      let score = 50;
      if (payoutRatio !== null) {
        if (payoutRatio < 0.3) score += 20;
        else if (payoutRatio < 0.6) score += 12;
        else if (payoutRatio < 0.9) score -= 5;
        else score -= 20;
      }
      if (fcfPayout !== null) {
        if (fcfPayout < 0.5) score += 15;
        else if (fcfPayout < 0.8) score += 8;
        else if (fcfPayout <= 1) score -= 5;
        else score -= 20;
      }
      if (dividendCoverage !== null) {
        if (dividendCoverage >= 3) score += 10;
        else if (dividendCoverage >= 1.5) score += 5;
        else if (dividendCoverage < 1) score -= 15;
      }
      if (netIncome <= 0) score -= 25;
      score = Math.max(0, Math.min(100, Math.round(score)));

      const result: PayoutCoverageResult = {
        available: true,
        symbol,
        payoutRatio,
        fcfPayout,
        dividendCoverage,
        buybackYield,
        totalShareholderYield,
        dividendYield,
        verdict,
        sustainabilityScore: score,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Payout coverage analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
