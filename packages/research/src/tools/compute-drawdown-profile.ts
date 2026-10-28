/**
 * Single-Instrument Drawdown Profile
 *
 * PURE compute tool (no io). Builds a drawdown profile from a price close
 * series — distinct from compute_drawdown which works on a portfolio VALUE
 * series. Computes the running peak, the full drawdown series, the max
 * drawdown (with peak/trough indices + dates), the current drawdown, recovery
 * bars for the max drawdown, every underwater period, the Ulcer Index, and the
 * pain index.
 *
 * Powers the regime-volatility skill.
 *
 * Inputs are injected by the executor from an upstream fetch_price_history
 * result:
 *   closes ← fetch_price_history.prices[].close
 *   dates  ← fetch_price_history.prices[].date  (optional)
 *
 * SEBI: outputs OBSERVATIONS / SCORES / FLAGS only. No buy/sell/hold or
 * target-price language. UseMoney is not a SEBI-registered Research Analyst.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface DrawdownProfileResult {
  available: boolean;
  /** Present only when available === false. */
  reason?: string;
  /** Echoed when supplied, for synthesizer traceability. */
  symbol?: string;

  /** Number of close observations used. */
  observations: number;

  /** Worst peak-to-trough decline as a fraction (negative, e.g. -0.2727). */
  maxDrawdown: number;
  /** Index of the peak that preceded the max drawdown. */
  maxDrawdownPeakIndex: number;
  /** Index of the trough of the max drawdown. */
  maxDrawdownTroughIndex: number;
  /** Date of the peak (null when dates not supplied). */
  maxDrawdownPeakDate: string | null;
  /** Date of the trough (null when dates not supplied). */
  maxDrawdownTroughDate: string | null;
  /**
   * Bars from the trough until the close first recovered back to the prior
   * peak. null when the series never recovered.
   */
  recoveryBars: number | null;

  /** Drawdown at the last observation as a fraction (<= 0). */
  currentDrawdown: number;

  /** Underwater stretches (peak-to-recovery), deepest first, capped at 10. */
  underwaterPeriods: Array<{
    startIndex: number;
    endIndex: number;
    depth: number; // most negative drawdown reached in the stretch
    durationBars: number;
  }>;

  /** Ulcer Index = sqrt(mean(dd^2)) over the series (>= 0, fraction). */
  ulcerIndex: number;
  /** Pain index = mean(|dd|) over the series (>= 0, fraction). */
  painIndex: number;

  /** Observational flags — no recommendations. */
  flags: string[];
}

const MIN_OBSERVATIONS = 30;

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export const computeDrawdownProfileTool: ResearchToolDef = {
  name: "compute_drawdown_profile",
  description:
    "Single-instrument drawdown profile from a price close series - max drawdown, recovery, underwater periods, Ulcer & pain index",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Chronological array of closing prices (oldest to newest), from fetch_price_history.prices[].close",
      required: true,
    },
    dates: {
      type: "array",
      description:
        "Optional chronological dates aligned to closes (YYYY-MM-DD), from fetch_price_history.prices[].date",
    },
    symbol: {
      type: "string",
      description: "Optional instrument symbol, echoed for traceability",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string" && params.symbol.length > 0
        ? params.symbol.toUpperCase()
        : undefined;

    try {
      const rawCloses = Array.isArray(params.closes) ? params.closes : [];
      const rawDates = Array.isArray(params.dates) ? params.dates : [];

      // Keep only finite, positive closes (a non-positive price cannot anchor a
      // valid percentage drawdown). Preserve alignment with the date array.
      const closes: number[] = [];
      const dates: (string | null) [] = [];
      for (let i = 0; i < rawCloses.length; i++) {
        const c = toFiniteNumber(rawCloses[i]);
        if (c === null || c <= 0) continue;
        closes.push(c);
        const d = rawDates[i];
        dates.push(typeof d === "string" && d.length > 0 ? d : null);
      }

      if (closes.length < MIN_OBSERVATIONS) {
        const degraded: DrawdownProfileResult = {
          available: false,
          reason: `Need at least ${MIN_OBSERVATIONS} valid closes for a drawdown profile (got ${closes.length})`,
          symbol,
          observations: closes.length,
          maxDrawdown: 0,
          maxDrawdownPeakIndex: -1,
          maxDrawdownTroughIndex: -1,
          maxDrawdownPeakDate: null,
          maxDrawdownTroughDate: null,
          recoveryBars: null,
          currentDrawdown: 0,
          underwaterPeriods: [],
          ulcerIndex: 0,
          painIndex: 0,
          flags: [],
        };
        return { success: true, data: degraded };
      }

      const hasDates = dates.some((d) => d !== null);

      // ── Running peak + drawdown series ──────────────────────────
      const drawdowns: number[] = new Array(closes.length);
      let peak = closes[0]!;
      let peakIndex = 0;

      let maxDrawdown = 0;
      let maxDDPeakIndex = 0;
      let maxDDTroughIndex = 0;

      let sumSquaredDD = 0;
      let sumAbsDD = 0;

      // Underwater bookkeeping: a stretch opens when price first falls below a
      // peak and closes when a new high (>= that peak) is reclaimed.
      const underwaterPeriods: DrawdownProfileResult["underwaterPeriods"] = [];
      let underwaterStartIndex: number | null = null; // index of the peak
      let underwaterDepth = 0;

      for (let i = 0; i < closes.length; i++) {
        const price = closes[i]!;

        if (price >= peak) {
          // New (or matched) high — close any open underwater stretch.
          if (underwaterStartIndex !== null) {
            underwaterPeriods.push({
              startIndex: underwaterStartIndex,
              endIndex: i,
              depth: round(underwaterDepth, 4),
              durationBars: i - underwaterStartIndex,
            });
            underwaterStartIndex = null;
            underwaterDepth = 0;
          }
          peak = price;
          peakIndex = i;
        } else if (underwaterStartIndex === null) {
          underwaterStartIndex = peakIndex;
        }

        const dd = (price - peak) / peak; // <= 0
        drawdowns[i] = dd;

        if (dd < underwaterDepth) underwaterDepth = dd;

        if (dd < maxDrawdown) {
          maxDrawdown = dd;
          maxDDPeakIndex = peakIndex;
          maxDDTroughIndex = i;
        }

        sumSquaredDD += dd * dd;
        sumAbsDD += Math.abs(dd);
      }

      // Still underwater at the series end.
      if (underwaterStartIndex !== null) {
        underwaterPeriods.push({
          startIndex: underwaterStartIndex,
          endIndex: closes.length - 1,
          depth: round(underwaterDepth, 4),
          durationBars: closes.length - 1 - underwaterStartIndex,
        });
      }

      const currentDrawdown = drawdowns[drawdowns.length - 1]!;

      // ── Recovery bars for the max drawdown ──────────────────────
      // Bars from the trough until the close reclaims the pre-drawdown peak.
      const peakValue = closes[maxDDPeakIndex]!;
      let recoveryBars: number | null = null;
      for (let i = maxDDTroughIndex + 1; i < closes.length; i++) {
        if (closes[i]! >= peakValue) {
          recoveryBars = i - maxDDTroughIndex;
          break;
        }
      }

      const ulcerIndex = Math.sqrt(sumSquaredDD / closes.length);
      const painIndex = sumAbsDD / closes.length;

      // Deepest underwater periods first, cap at 10 for payload size.
      const topUnderwater = [...underwaterPeriods]
        .sort((a, b) => a.depth - b.depth)
        .slice(0, 10);

      // ── Observational flags (no recommendations) ────────────────
      const flags: string[] = [];
      const maxDDPct = Math.abs(maxDrawdown) * 100;

      if (maxDDPct >= 50) {
        flags.push(
          `Severe historical drawdown - peak-to-trough decline reached ${maxDDPct.toFixed(1)}%`,
        );
      } else if (maxDDPct >= 30) {
        flags.push(
          `Deep historical drawdown observed (${maxDDPct.toFixed(1)}% peak-to-trough)`,
        );
      }

      if (Math.abs(currentDrawdown) * 100 >= 20) {
        flags.push(
          `Currently ${(Math.abs(currentDrawdown) * 100).toFixed(1)}% below its prior peak`,
        );
      } else if (currentDrawdown === 0) {
        flags.push("Trading at or above its prior peak (no current drawdown)");
      }

      if (maxDrawdown < 0 && recoveryBars === null) {
        flags.push(
          "Max drawdown has not yet recovered to the prior peak within the observed window",
        );
      }

      if (ulcerIndex * 100 >= 15) {
        flags.push(
          `Elevated Ulcer Index (${(ulcerIndex * 100).toFixed(1)}) - persistent and deep drawdowns`,
        );
      }

      const result: DrawdownProfileResult = {
        available: true,
        symbol,
        observations: closes.length,
        maxDrawdown: round(maxDrawdown, 4),
        maxDrawdownPeakIndex: maxDDPeakIndex,
        maxDrawdownTroughIndex: maxDDTroughIndex,
        maxDrawdownPeakDate: hasDates ? (dates[maxDDPeakIndex] ?? null) : null,
        maxDrawdownTroughDate: hasDates
          ? (dates[maxDDTroughIndex] ?? null)
          : null,
        recoveryBars,
        currentDrawdown: round(currentDrawdown, 4),
        underwaterPeriods: topUnderwater,
        ulcerIndex: round(ulcerIndex, 4),
        painIndex: round(painIndex, 4),
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Drawdown profile computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
