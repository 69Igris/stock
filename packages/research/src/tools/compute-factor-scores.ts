/**
 * Factor Scores (Academic Five-Factor Model) — observation only.
 *
 * Computes raw 0-100 scores for the canonical equity style factors:
 *   VALUE     — cheapness of multiples (PE, PB, EV/EBITDA, FCF yield, div yield)
 *   QUALITY   — profitability + balance-sheet strength (ROE, ROA, margins,
 *               debt/equity, current ratio)
 *   MOMENTUM  — trailing price strength (12-1m return, 6m return, distance
 *               from 52w high, 50/200 SMA position)
 *   GROWTH    — fundamental expansion (revenue growth, earnings growth, EPS CAGR)
 *   LOW_VOL   — inverse of annualized realized volatility + beta
 *
 * Each sub-input is mapped to 0-100 via a bounded, monotone transform (bounds
 * documented inline). Factor score = mean of its available sub-scores; a factor
 * is null when none of its inputs are present. This is a SEBI-compliant
 * observation tool: it emits scores and a descriptive style-tilt label only,
 * never buy/sell/hold/target guidance.
 *
 * PURE compute tool: no network, no db, no io. All inputs arrive via params,
 * injected by the executor from upstream fetch results:
 *   - ratio fields  ← fetch_key_ratios
 *   - closes[]      ← fetch_price_history.prices[].close
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result Interface ───────────────────────────────────────

export interface FactorSubScore {
  /** Raw inputs that fed this factor (only the ones that were present). */
  inputs: Record<string, number>;
  /** Bounded 0-100 score, or null when no inputs were available. */
  score: number | null;
  /** Short note when the factor is partial or absent. */
  note?: string;
}

export interface FactorScoresResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  factors: {
    value: FactorSubScore;
    quality: FactorSubScore;
    momentum: FactorSubScore;
    growth: FactorSubScore;
    lowVol: FactorSubScore;
  };
  /** Mean of the available factor scores (0-100), or null if none. */
  compositeScore: number | null;
  /** Factor keys that could be computed, ordered by score (desc). */
  availableFactors: string[];
  /** Descriptive tilt label, e.g. "value+quality" or "no clear tilt". */
  styleTilt: string;
  /** Plain-language observations (no recommendations). */
  observations: string[];
}

// ─── Pure helpers ───────────────────────────────────────────

/** Read a finite number from params, else undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Coerce an unknown into a clean numeric closes array (chronological). */
function toCloses(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = num(x);
    if (n !== undefined && n > 0) out.push(n);
  }
  return out;
}

const clamp = (n: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, n));

const round0 = (n: number): number => Math.round(n);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Linear "lower-is-better" transform: value at/below `best` → 100, at/above
 * `worst` → 0. Used for valuation multiples.
 */
function lowerBetter(value: number, best: number, worst: number): number {
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return clamp((100 * (worst - value)) / (worst - best));
}

/**
 * Linear "higher-is-better" transform: value at/above `best` → 100, at/below
 * `worst` → 0. Used for profitability / yield.
 */
function higherBetter(value: number, worst: number, best: number): number {
  if (value >= best) return 100;
  if (value <= worst) return 0;
  return clamp((100 * (value - worst)) / (best - worst));
}

/** Mean of a non-empty numeric array. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Simple moving average of the last `period` closes. */
function smaLast(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return mean(closes.slice(closes.length - period));
}

// ─── Tool ───────────────────────────────────────────────────

export const computeFactorScoresTool: ResearchToolDef = {
  name: "compute_factor_scores",
  description:
    "Compute academic five-factor raw scores (value, quality, momentum, growth, low-vol) on a 0-100 scale with a descriptive style-tilt label — observation only",
  category: "computation",
  parameters: {
    symbol: { type: "string", description: "Ticker for labelling output" },
    // VALUE inputs (from fetch_key_ratios)
    pe: { type: "number", description: "Price/Earnings (lower = better value)" },
    pb: { type: "number", description: "Price/Book (lower = better value)" },
    evToEbitda: {
      type: "number",
      description: "EV/EBITDA (lower = better value)",
    },
    fcfYield: {
      type: "number",
      description: "Free cash flow yield as a fraction (e.g. 0.05 = 5%)",
    },
    dividendYield: {
      type: "number",
      description: "Dividend yield as a fraction (e.g. 0.02 = 2%)",
    },
    // QUALITY inputs (from fetch_key_ratios)
    roe: { type: "number", description: "Return on equity (% or fraction)" },
    roa: { type: "number", description: "Return on assets (% or fraction)" },
    netMargin: { type: "number", description: "Net margin (% or fraction)" },
    operatingMargin: {
      type: "number",
      description: "Operating margin (% or fraction)",
    },
    debtToEquity: {
      type: "number",
      description: "Debt/Equity ratio (lower = better quality)",
    },
    currentRatio: {
      type: "number",
      description: "Current ratio (higher = better liquidity)",
    },
    // GROWTH inputs (from fetch_key_ratios)
    revenueGrowth: {
      type: "number",
      description: "YoY revenue growth (% or fraction)",
    },
    earningsGrowth: {
      type: "number",
      description: "YoY earnings growth (% or fraction)",
    },
    epsCAGR: { type: "number", description: "Multi-year EPS CAGR (% or fraction)" },
    // MOMENTUM + LOW_VOL inputs
    closes: {
      type: "array",
      description:
        "Closing prices, chronological (oldest first). From fetch_price_history.prices[].close. Powers momentum + realized volatility.",
    },
    beta: {
      type: "number",
      description: "Equity beta vs market (lower magnitude = lower vol)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" && params.symbol.trim()
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      // ── Read & normalise inputs ──────────────────────────────
      const pe = num(params.pe);
      const pb = num(params.pb);
      const evToEbitda = num(params.evToEbitda);
      const fcfYield = num(params.fcfYield);
      const dividendYield = num(params.dividendYield);

      const roe = num(params.roe);
      const roa = num(params.roa);
      const netMargin = num(params.netMargin);
      const operatingMargin = num(params.operatingMargin);
      const debtToEquity = num(params.debtToEquity);
      const currentRatio = num(params.currentRatio);

      const revenueGrowth = num(params.revenueGrowth);
      const earningsGrowth = num(params.earningsGrowth);
      const epsCAGR = num(params.epsCAGR);

      const beta = num(params.beta);
      const closes = toCloses(params.closes);

      const hasRatios =
        pe !== undefined ||
        pb !== undefined ||
        evToEbitda !== undefined ||
        fcfYield !== undefined ||
        dividendYield !== undefined ||
        roe !== undefined ||
        roa !== undefined ||
        netMargin !== undefined ||
        operatingMargin !== undefined ||
        debtToEquity !== undefined ||
        currentRatio !== undefined ||
        revenueGrowth !== undefined ||
        earningsGrowth !== undefined ||
        epsCAGR !== undefined ||
        beta !== undefined;

      // Graceful degradation: neither ratios nor a usable price series.
      if (!hasRatios && closes.length === 0) {
        const empty: FactorSubScore = { inputs: {}, score: null };
        const degraded: FactorScoresResult = {
          available: false,
          reason:
            "No valuation/quality ratios and no price history were provided to compute factor scores",
          symbol,
          factors: {
            value: empty,
            quality: empty,
            momentum: empty,
            growth: empty,
            lowVol: empty,
          },
          compositeScore: null,
          availableFactors: [],
          styleTilt: "insufficient data",
          observations: [],
        };
        return { success: true, data: degraded };
      }

      /**
       * Percent inputs may arrive as fractions (0.18) or percents (18). For
       * ratio-style metrics that are conventionally <1 as a fraction (margins,
       * ROE, growth, yields), treat |x| <= 1.5 as a fraction and scale to %.
       */
      const asPct = (x: number | undefined): number | undefined =>
        x === undefined ? undefined : Math.abs(x) <= 1.5 ? x * 100 : x;

      const roePct = asPct(roe);
      const roaPct = asPct(roa);
      const netMarginPct = asPct(netMargin);
      const opMarginPct = asPct(operatingMargin);
      const revGrowthPct = asPct(revenueGrowth);
      const earnGrowthPct = asPct(earningsGrowth);
      const epsCagrPct = asPct(epsCAGR);
      const fcfYieldPct = asPct(fcfYield);
      const divYieldPct = asPct(dividendYield);

      // ── VALUE ───────────────────────────────────────────────
      // Bounds (India large/mid-cap heuristics):
      //   PE        best 8  → worst 50  (lower better)
      //   PB        best 1  → worst 10  (lower better)
      //   EV/EBITDA best 5  → worst 25  (lower better)
      //   FCF yield worst 0% → best 10% (higher better)
      //   Div yield worst 0% → best 6%  (higher better)
      const valueInputs: Record<string, number> = {};
      const valueScores: number[] = [];
      if (pe !== undefined && pe > 0) {
        valueInputs.pe = round2(pe);
        valueScores.push(lowerBetter(pe, 8, 50));
      }
      if (pb !== undefined && pb > 0) {
        valueInputs.pb = round2(pb);
        valueScores.push(lowerBetter(pb, 1, 10));
      }
      if (evToEbitda !== undefined && evToEbitda > 0) {
        valueInputs.evToEbitda = round2(evToEbitda);
        valueScores.push(lowerBetter(evToEbitda, 5, 25));
      }
      if (fcfYieldPct !== undefined) {
        valueInputs.fcfYieldPct = round2(fcfYieldPct);
        valueScores.push(higherBetter(fcfYieldPct, 0, 10));
      }
      if (divYieldPct !== undefined) {
        valueInputs.dividendYieldPct = round2(divYieldPct);
        valueScores.push(higherBetter(divYieldPct, 0, 6));
      }

      // ── QUALITY ─────────────────────────────────────────────
      // Bounds:
      //   ROE       worst 0%  → best 30% (higher better)
      //   ROA       worst 0%  → best 15% (higher better)
      //   Net mgn   worst 0%  → best 25% (higher better)
      //   Op mgn    worst 0%  → best 30% (higher better)
      //   D/E       best 0    → worst 2  (lower better)
      //   Curr rat  worst 0.5 → best 2.5 (higher better, then plateau)
      const qualityInputs: Record<string, number> = {};
      const qualityScores: number[] = [];
      if (roePct !== undefined) {
        qualityInputs.roePct = round2(roePct);
        qualityScores.push(higherBetter(roePct, 0, 30));
      }
      if (roaPct !== undefined) {
        qualityInputs.roaPct = round2(roaPct);
        qualityScores.push(higherBetter(roaPct, 0, 15));
      }
      if (netMarginPct !== undefined) {
        qualityInputs.netMarginPct = round2(netMarginPct);
        qualityScores.push(higherBetter(netMarginPct, 0, 25));
      }
      if (opMarginPct !== undefined) {
        qualityInputs.operatingMarginPct = round2(opMarginPct);
        qualityScores.push(higherBetter(opMarginPct, 0, 30));
      }
      if (debtToEquity !== undefined && debtToEquity >= 0) {
        qualityInputs.debtToEquity = round2(debtToEquity);
        qualityScores.push(lowerBetter(debtToEquity, 0, 2));
      }
      if (currentRatio !== undefined && currentRatio > 0) {
        qualityInputs.currentRatio = round2(currentRatio);
        qualityScores.push(higherBetter(currentRatio, 0.5, 2.5));
      }

      // ── MOMENTUM ────────────────────────────────────────────
      // Daily closes assumed (~21 trading days/month, ~252/year).
      //   12-1m return  worst -30% → best +50% (skips most-recent month)
      //   6m return     worst -25% → best +40%
      //   % from 52w hi worst -50% → best 0%   (closer to high = stronger)
      //   SMA position  +50 if px>SMA50>SMA200, +25 if px>SMA50, else 0
      const momentumInputs: Record<string, number> = {};
      const momentumScores: number[] = [];
      let momentumNote: string | undefined;
      if (closes.length >= 2) {
        const last = closes[closes.length - 1]!;
        const D = 21; // trading days / month
        const Y = 252; // trading days / year

        // 12-1 month return (skip last month).
        if (closes.length >= Y + 1) {
          const start = closes[closes.length - 1 - Y]!;
          const endSkip = closes[closes.length - 1 - D]!;
          if (start > 0) {
            const ret12_1 = ((endSkip - start) / start) * 100;
            momentumInputs.return12_1mPct = round2(ret12_1);
            momentumScores.push(higherBetter(ret12_1, -30, 50));
          }
        }

        // 6-month return.
        if (closes.length >= 6 * D + 1) {
          const start6 = closes[closes.length - 1 - 6 * D]!;
          if (start6 > 0) {
            const ret6 = ((last - start6) / start6) * 100;
            momentumInputs.return6mPct = round2(ret6);
            momentumScores.push(higherBetter(ret6, -25, 40));
          }
        }

        // Distance from trailing 52w (or full-window) high.
        const window = closes.slice(
          Math.max(0, closes.length - (Y + 1)),
        );
        const high52 = Math.max(...window);
        if (high52 > 0) {
          const distFromHigh = ((last - high52) / high52) * 100; // <= 0
          momentumInputs.distFrom52wHighPct = round2(distFromHigh);
          momentumScores.push(higherBetter(distFromHigh, -50, 0));
        }

        // 50/200 SMA position.
        const sma50 = smaLast(closes, 50);
        const sma200 = smaLast(closes, 200);
        if (sma50 !== null) {
          momentumInputs.sma50 = round2(sma50);
          if (sma200 !== null) momentumInputs.sma200 = round2(sma200);
          let smaScore = 0;
          if (sma200 !== null && last > sma50 && sma50 > sma200) smaScore = 100;
          else if (last > sma50) smaScore = 50;
          else if (sma200 !== null && last < sma50 && sma50 < sma200)
            smaScore = 0;
          else smaScore = 25;
          momentumScores.push(smaScore);
        }

        if (closes.length < 6 * D + 1) {
          momentumNote =
            "Price history shorter than 6 months — momentum based on available window only";
        }
      } else if (closes.length === 1) {
        momentumNote = "Single price point — momentum not computable";
      }

      // ── GROWTH ──────────────────────────────────────────────
      //   Revenue growth  worst -10% → best +30%
      //   Earnings growth worst -20% → best +40%
      //   EPS CAGR        worst -10% → best +30%
      const growthInputs: Record<string, number> = {};
      const growthScores: number[] = [];
      if (revGrowthPct !== undefined) {
        growthInputs.revenueGrowthPct = round2(revGrowthPct);
        growthScores.push(higherBetter(revGrowthPct, -10, 30));
      }
      if (earnGrowthPct !== undefined) {
        growthInputs.earningsGrowthPct = round2(earnGrowthPct);
        growthScores.push(higherBetter(earnGrowthPct, -20, 40));
      }
      if (epsCagrPct !== undefined) {
        growthInputs.epsCAGRPct = round2(epsCagrPct);
        growthScores.push(higherBetter(epsCagrPct, -10, 30));
      }

      // ── LOW_VOL ─────────────────────────────────────────────
      //   Annualized realized vol worst 60% → best 10% (lower better)
      //   Beta (abs)              worst 2.0 → best 0.4 (lower better)
      const lowVolInputs: Record<string, number> = {};
      const lowVolScores: number[] = [];
      if (closes.length >= 21) {
        const rets: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          const prev = closes[i - 1]!;
          const cur = closes[i]!;
          if (prev > 0) rets.push(cur / prev - 1);
        }
        if (rets.length >= 20) {
          const m = mean(rets);
          const variance =
            rets.reduce((acc, r) => acc + (r - m) * (r - m), 0) /
            (rets.length - 1);
          const dailyVol = Math.sqrt(variance);
          const annVolPct = dailyVol * Math.sqrt(252) * 100;
          lowVolInputs.annualizedVolPct = round2(annVolPct);
          lowVolScores.push(lowerBetter(annVolPct, 10, 60));
        }
      }
      if (beta !== undefined) {
        lowVolInputs.beta = round2(beta);
        lowVolScores.push(lowerBetter(Math.abs(beta), 0.4, 2.0));
      }

      // ── Assemble per-factor sub-scores ───────────────────────
      const factorize = (
        inputs: Record<string, number>,
        scores: number[],
        note?: string,
      ): FactorSubScore => {
        const sub: FactorSubScore = {
          inputs,
          score: scores.length ? round0(mean(scores)) : null,
        };
        if (note) sub.note = note;
        else if (scores.length === 0)
          sub.note = "No inputs available for this factor";
        return sub;
      };

      const factors: FactorScoresResult["factors"] = {
        value: factorize(valueInputs, valueScores),
        quality: factorize(qualityInputs, qualityScores),
        momentum: factorize(momentumInputs, momentumScores, momentumNote),
        growth: factorize(growthInputs, growthScores),
        lowVol: factorize(lowVolInputs, lowVolScores),
      };

      // ── Composite + tilt + observations ──────────────────────
      interface LabelledFactor {
        key: string;
        label: string;
        score: number;
      }
      const factorLabels: Array<[keyof typeof factors, string]> = [
        ["value", "value"],
        ["quality", "quality"],
        ["momentum", "momentum"],
        ["growth", "growth"],
        ["lowVol", "low-vol"],
      ];
      const labelled: LabelledFactor[] = [];
      for (const [key, label] of factorLabels) {
        const score = factors[key].score;
        if (score !== null) labelled.push({ key, label, score });
      }

      const compositeScore = labelled.length
        ? round0(mean(labelled.map((f) => f.score)))
        : null;

      const ranked = [...labelled].sort((a, b) => b.score - a.score);
      const availableFactors = ranked.map((f) => f.key);

      // Style tilt: factors scoring >= 60 are "tilts"; combine top ones.
      const strong = ranked.filter((f) => f.score >= 60);
      let styleTilt: string;
      if (strong.length === 0) {
        styleTilt = "no clear tilt";
      } else {
        styleTilt = strong
          .slice(0, 2)
          .map((f) => f.label)
          .join("+");
      }

      const observations: string[] = [];
      for (const f of ranked) {
        if (f.score >= 75)
          observations.push(`Strong ${f.label} characteristics (score ${f.score}/100)`);
        else if (f.score <= 25)
          observations.push(`Weak ${f.label} characteristics (score ${f.score}/100)`);
      }
      if (labelled.length < 5) {
        const missing = (
          ["value", "quality", "momentum", "growth", "lowVol"] as const
        ).filter((k) => factors[k].score === null);
        if (missing.length)
          observations.push(
            `Factors not computed (insufficient data): ${missing.join(", ")}`,
          );
      }
      if (
        compositeScore !== null &&
        round4(compositeScore) === compositeScore
      ) {
        observations.push(
          `Composite factor score ${compositeScore}/100 across ${labelled.length} factor(s)`,
        );
      }

      const result: FactorScoresResult = {
        available: true,
        symbol,
        factors,
        compositeScore,
        availableFactors,
        styleTilt,
        observations,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Factor score computation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
