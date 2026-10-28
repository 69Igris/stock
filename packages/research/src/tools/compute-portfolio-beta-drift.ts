/**
 * Portfolio Beta & Drift Analysis
 *
 * Given current holdings [{ symbol, value, beta }], computes the
 * value-weighted portfolio beta, its drift versus a target beta
 * (default 1.0 = market), each holding's beta contribution
 * (weight x beta), and how a candidate position would shift the
 * portfolio beta.
 *
 * PURE compute tool - no network/db/io. All inputs read from params.
 * Holdings are injected by the executor from an upstream server-action
 * fetch. In single-stock research there is no portfolio context, so the
 * tool degrades gracefully (available:false, reason 'no portfolio
 * context') instead of fabricating numbers.
 *
 * SEBI: emits observations / scores / flags only. No buy/sell/hold or
 * target-price language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface PortfolioBetaDriftResult {
  available: boolean;
  /** Present only when available === false */
  reason?: string;
  /** Echoed when supplied so the synthesizer can scope the observation */
  symbol?: string;

  /** Value-weighted portfolio beta (2 dp) */
  portfolioBeta: number;
  /** Target beta the drift is measured against (default 1.0) */
  targetBeta: number;
  /** portfolioBeta - targetBeta (2 dp); >0 = more market-sensitive than target */
  drift: number;
  /** Absolute drift expressed as a band */
  driftLevel: "aligned" | "minor" | "moderate" | "large";
  /** Total portfolio value used for weighting */
  totalValue: number;
  /** Count of holdings that carried a usable beta */
  betaCoverage: number;
  /** Total holdings supplied (some may lack a beta) */
  holdingsCount: number;

  /** Per-holding beta contribution = weight x beta, descending by |contribution| */
  contributions: Array<{
    symbol: string;
    value: number;
    weight: number; // 0-1
    beta: number;
    contribution: number; // weight x beta
  }>;

  /** Optional: how a candidate position would shift the portfolio beta */
  candidateImpact?: {
    candidateBeta: number;
    candidateValue: number;
    candidateWeight: number; // weight in the post-add portfolio (0-1)
    newPortfolioBeta: number; // 2 dp
    betaShift: number; // newPortfolioBeta - portfolioBeta (2 dp)
    newDrift: number; // newPortfolioBeta - targetBeta (2 dp)
  };

  /** Neutral observations (no advice) */
  flags: string[];
}

interface RawHolding {
  symbol?: unknown;
  value?: unknown;
  beta?: unknown;
}

interface RawCandidate {
  value?: unknown;
  beta?: unknown;
}

function toFiniteNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim() !== "") {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export const computePortfolioBetaDriftTool: ResearchToolDef = {
  name: "compute_portfolio_beta_drift",
  description:
    "Compute value-weighted portfolio beta, drift vs a target beta, per-holding beta contribution, and candidate position impact",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description:
        "Array of { symbol, value, beta } for current holdings. Absent in single-stock research (degrades gracefully).",
      required: true,
    },
    targetBeta: {
      type: "number",
      description: "Target portfolio beta to measure drift against",
      default: 1.0,
    },
    candidate: {
      type: "object",
      description:
        "Optional { value, beta } position to test how it would shift the portfolio beta",
    },
    symbol: {
      type: "string",
      description: "Optional research symbol to scope the observation",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbolParam =
        typeof params.symbol === "string" && params.symbol.trim() !== ""
          ? params.symbol.trim().toUpperCase()
          : undefined;

      const rawHoldings = Array.isArray(params.holdings)
        ? (params.holdings as RawHolding[])
        : undefined;

      // ── Graceful degradation: no portfolio context ───────────────
      if (!rawHoldings || rawHoldings.length === 0) {
        const result: PortfolioBetaDriftResult = {
          available: false,
          reason: "no portfolio context",
          symbol: symbolParam,
          portfolioBeta: 0,
          targetBeta:
            toFiniteNumber(params.targetBeta) ?? 1.0,
          drift: 0,
          driftLevel: "aligned",
          totalValue: 0,
          betaCoverage: 0,
          holdingsCount: 0,
          contributions: [],
          flags: [],
        };
        return { success: true, data: result };
      }

      // ── Normalise holdings ───────────────────────────────────────
      const parsed = rawHoldings.map((h) => {
        const value = toFiniteNumber(h.value);
        const beta = toFiniteNumber(h.beta);
        const symbol =
          typeof h.symbol === "string" && h.symbol.trim() !== ""
            ? h.symbol.trim().toUpperCase()
            : "UNKNOWN";
        return { symbol, value, beta };
      });

      // Only positive-value holdings contribute to weighting.
      const valued = parsed.filter(
        (h): h is { symbol: string; value: number; beta: number | null } =>
          h.value !== null && h.value > 0,
      );

      const totalValue = valued.reduce((sum, h) => sum + h.value, 0);

      if (totalValue <= 0) {
        const result: PortfolioBetaDriftResult = {
          available: false,
          reason: "no portfolio context",
          symbol: symbolParam,
          portfolioBeta: 0,
          targetBeta: toFiniteNumber(params.targetBeta) ?? 1.0,
          drift: 0,
          driftLevel: "aligned",
          totalValue: 0,
          betaCoverage: 0,
          holdingsCount: parsed.length,
          contributions: [],
          flags: [],
        };
        return { success: true, data: result };
      }

      // Holdings with a usable beta drive the portfolio beta.
      const withBeta = valued.filter(
        (h): h is { symbol: string; value: number; beta: number } =>
          h.beta !== null,
      );

      // ── Graceful degradation: values present but no betas ────────
      if (withBeta.length === 0) {
        const result: PortfolioBetaDriftResult = {
          available: false,
          reason: "no portfolio context",
          symbol: symbolParam,
          portfolioBeta: 0,
          targetBeta: toFiniteNumber(params.targetBeta) ?? 1.0,
          drift: 0,
          driftLevel: "aligned",
          totalValue: Math.round(totalValue),
          betaCoverage: 0,
          holdingsCount: parsed.length,
          contributions: [],
          flags: [],
        };
        return { success: true, data: result };
      }

      const targetBeta = toFiniteNumber(params.targetBeta) ?? 1.0;

      // Portfolio beta is weighted over the value that actually carries a
      // beta (covered value), so a partial-coverage portfolio still yields
      // an honest weighted beta rather than diluting toward zero.
      const coveredValue = withBeta.reduce((sum, h) => sum + h.value, 0);

      const contributions = withBeta
        .map((h) => {
          const weight = h.value / coveredValue;
          return {
            symbol: h.symbol,
            value: Math.round(h.value),
            weight: round4(weight),
            beta: round2(h.beta),
            contribution: round4(weight * h.beta),
          };
        })
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

      const portfolioBetaRaw = withBeta.reduce(
        (sum, h) => sum + (h.value / coveredValue) * h.beta,
        0,
      );
      const portfolioBeta = round2(portfolioBetaRaw);
      const drift = round2(portfolioBetaRaw - targetBeta);
      const absDrift = Math.abs(drift);

      const driftLevel: PortfolioBetaDriftResult["driftLevel"] =
        absDrift <= 0.05
          ? "aligned"
          : absDrift <= 0.15
            ? "minor"
            : absDrift <= 0.3
              ? "moderate"
              : "large";

      // ── Flags: neutral observations only (no advice) ─────────────
      const flags: string[] = [];
      const coveragePct = coveredValue / totalValue;

      if (coveragePct < 0.99) {
        flags.push(
          `Beta coverage is ${(coveragePct * 100).toFixed(1)}% of portfolio value (${withBeta.length}/${valued.length} valued holdings have a beta); portfolio beta reflects only the covered slice`,
        );
      }

      if (driftLevel === "large") {
        if (drift > 0) {
          flags.push(
            `Portfolio beta ${portfolioBeta} sits well above target ${round2(targetBeta)} (drift +${drift}) - more sensitive to market swings than the target profile`,
          );
        } else {
          flags.push(
            `Portfolio beta ${portfolioBeta} sits well below target ${round2(targetBeta)} (drift ${drift}) - less sensitive to market swings than the target profile`,
          );
        }
      } else if (driftLevel === "aligned") {
        flags.push(
          `Portfolio beta ${portfolioBeta} is closely aligned with target ${round2(targetBeta)} (drift ${drift >= 0 ? "+" : ""}${drift})`,
        );
      }

      const top = contributions[0];
      if (top && contributions.length > 1 && top.weight > 0.25) {
        flags.push(
          `${top.symbol} alone contributes ${top.contribution} to portfolio beta (${(top.weight * 100).toFixed(1)}% weight, beta ${top.beta}) - a single dominant driver of market sensitivity`,
        );
      }

      const result: PortfolioBetaDriftResult = {
        available: true,
        symbol: symbolParam,
        portfolioBeta,
        targetBeta: round2(targetBeta),
        drift,
        driftLevel,
        totalValue: Math.round(totalValue),
        betaCoverage: withBeta.length,
        holdingsCount: parsed.length,
        contributions,
        flags,
      };

      // ── Candidate impact (optional) ──────────────────────────────
      const rawCandidate =
        params.candidate && typeof params.candidate === "object"
          ? (params.candidate as RawCandidate)
          : undefined;

      if (rawCandidate) {
        const candidateValue = toFiniteNumber(rawCandidate.value);
        const candidateBeta = toFiniteNumber(rawCandidate.beta);

        if (
          candidateValue !== null &&
          candidateValue > 0 &&
          candidateBeta !== null
        ) {
          // New beta weights over covered value + candidate (candidate has
          // a known beta, so it joins the covered slice).
          const newCoveredValue = coveredValue + candidateValue;
          const newPortfolioBetaRaw =
            (coveredValue * portfolioBetaRaw + candidateValue * candidateBeta) /
            newCoveredValue;
          const newPortfolioBeta = round2(newPortfolioBetaRaw);

          result.candidateImpact = {
            candidateBeta: round2(candidateBeta),
            candidateValue: Math.round(candidateValue),
            // Weight relative to the post-add total portfolio value.
            candidateWeight: round4(
              candidateValue / (totalValue + candidateValue),
            ),
            newPortfolioBeta,
            betaShift: round2(newPortfolioBetaRaw - portfolioBetaRaw),
            newDrift: round2(newPortfolioBetaRaw - targetBeta),
          };

          const shift = result.candidateImpact.betaShift;
          if (Math.abs(shift) >= 0.05) {
            flags.push(
              `Adding the candidate (value ${result.candidateImpact.candidateValue}, beta ${result.candidateImpact.candidateBeta}) would shift portfolio beta by ${shift >= 0 ? "+" : ""}${shift} to ${newPortfolioBeta} (new drift ${result.candidateImpact.newDrift >= 0 ? "+" : ""}${result.candidateImpact.newDrift})`,
            );
          }
        }
      }

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Portfolio beta drift computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
