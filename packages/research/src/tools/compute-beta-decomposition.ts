/**
 * Beta Decomposition vs Benchmark (Nifty)
 *
 * PURE compute tool — no network/db/io. Inputs are injected by the executor
 * from upstream fetch_price_history results (subject symbol + Nifty benchmark).
 *
 * Decomposes market risk relative to a benchmark:
 *   - overall beta = Cov(R_s, R_b) / Var(R_b)
 *   - correlation, R2 (systematic share of variance)
 *   - idiosyncraticVol = sqrt(1 - R2) * stockAnnualizedVol   (stock-specific risk)
 *   - systematicVol    = sqrt(R2)     * stockAnnualizedVol   (market-driven risk)
 *   - bull beta (regress only on benchmark up-days) vs bear beta (down-days)
 *     to surface downside-beta asymmetry
 *   - upCapture / downCapture ratios (mean stock return on up/down bench days
 *     ÷ mean benchmark return on those days)
 *   - rollingBetaRecent (last ~60 obs) vs full-window beta → betaTrend
 *
 * SEBI: observations / scores / flags only. No buy/sell/target language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface BetaDecompositionResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Number of paired daily-return observations used */
  observations?: number;
  /** Overall market beta vs benchmark */
  beta?: number;
  /** Pearson correlation between stock and benchmark returns */
  correlation?: number;
  /** R-squared = correlation^2 = systematic share of variance (0..1) */
  r2?: number;
  /** Annualized stock volatility (daily std × √252) */
  stockAnnualizedVol?: number;
  /** Annualized benchmark volatility (daily std × √252) */
  benchmarkAnnualizedVol?: number;
  /** Market-driven annualized vol = √R2 × stockAnnualizedVol */
  systematicVol?: number;
  /** Stock-specific annualized vol = √(1−R2) × stockAnnualizedVol */
  idiosyncraticVol?: number;
  /** Beta estimated on benchmark up-days only (null if too few up-days) */
  bullBeta?: number | null;
  /** Beta estimated on benchmark down-days only (null if too few down-days) */
  bearBeta?: number | null;
  /** bearBeta − bullBeta; positive = falls harder than it rises (downside skew) */
  downsideAsymmetry?: number | null;
  /** Mean stock return ÷ mean benchmark return on benchmark up-days */
  upCapture?: number | null;
  /** Mean stock return ÷ mean benchmark return on benchmark down-days */
  downCapture?: number | null;
  /** Beta over the most recent ~60 observations */
  rollingBetaRecent?: number | null;
  /** Direction of recent beta vs full-window beta */
  betaTrend?: "rising" | "falling" | "stable";
  /** Qualitative market-sensitivity bucket from overall beta */
  sensitivity?: "defensive" | "market" | "aggressive";
  /** Plain-language observations (no recommendations) */
  observationsText?: string[];
}

const TRADING_DAYS_PER_YEAR = 252;
const MIN_OBSERVATIONS = 20;
const ROLLING_WINDOW = 60;
const MIN_REGIME_DAYS = 10; // minimum up/down days to report a regime beta

/** Coerce an unknown value into a finite-number array, dropping non-numerics. */
function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Simple returns from a close series: r_t = close_t / close_{t-1} − 1. */
function closesToReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev !== 0 && Number.isFinite(prev)) {
      returns.push(closes[i]! / prev - 1);
    }
  }
  return returns;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Beta of y on x using sample (n−1) covariance/variance. Returns null if degenerate. */
function regressBeta(y: number[], x: number[]): number | null {
  const n = Math.min(y.length, x.length);
  if (n < 2) return null;
  const ym = mean(y.slice(0, n));
  const xm = mean(x.slice(0, n));
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - xm;
    cov += (y[i]! - ym) * dx;
    varX += dx * dx;
  }
  if (varX <= 0) return null;
  return cov / varX;
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export const computeBetaDecompositionTool: ResearchToolDef = {
  name: "compute_beta_decomposition",
  description:
    "Decompose market beta vs Nifty into systematic/idiosyncratic vol, bull/bear beta asymmetry, up/down capture, and beta trend",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Subject stock symbol (for labelling output)",
    },
    stockReturns: {
      type: "array",
      description: "Stock daily returns (decimals); preferred if available",
    },
    stockCloses: {
      type: "array",
      description:
        "Stock close prices (oldest→newest) from fetch_price_history .prices[].close; returns derived if stockReturns absent",
    },
    benchmarkReturns: {
      type: "array",
      description: "Benchmark (Nifty) daily returns (decimals)",
    },
    benchmarkCloses: {
      type: "array",
      description:
        "Benchmark (Nifty / ^NSEI) close prices from fetch_price_history .prices[].close; returns derived if benchmarkReturns absent",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" && params.symbol
          ? params.symbol
          : undefined;

      // Resolve stock return series: explicit returns win, else derive from closes.
      const stockReturnsParam = toNumberArray(params.stockReturns);
      const stockCloses = toNumberArray(params.stockCloses);
      const stockReturns =
        stockReturnsParam.length > 0
          ? stockReturnsParam
          : closesToReturns(stockCloses);

      // Resolve benchmark return series.
      const benchReturnsParam = toNumberArray(params.benchmarkReturns);
      const benchCloses = toNumberArray(params.benchmarkCloses);
      const benchReturns =
        benchReturnsParam.length > 0
          ? benchReturnsParam
          : closesToReturns(benchCloses);

      // Graceful degradation — honest "—" rather than fabricated numbers.
      if (benchReturns.length === 0) {
        return {
          success: true,
          data: {
            available: false,
            reason: "no benchmark series",
            symbol,
          } satisfies BetaDecompositionResult,
        };
      }
      if (stockReturns.length === 0) {
        return {
          success: true,
          data: {
            available: false,
            reason: "no stock return series",
            symbol,
          } satisfies BetaDecompositionResult,
        };
      }

      const n = Math.min(stockReturns.length, benchReturns.length);
      if (n < MIN_OBSERVATIONS) {
        return {
          success: true,
          data: {
            available: false,
            reason: `only ${n} paired observations (need ${MIN_OBSERVATIONS})`,
            symbol,
          } satisfies BetaDecompositionResult,
        };
      }

      // Align tail-first so the most recent observations are paired.
      const s = stockReturns.slice(-n);
      const b = benchReturns.slice(-n);

      const sMean = mean(s);
      const bMean = mean(b);

      let cov = 0;
      let varB = 0;
      let varS = 0;
      for (let i = 0; i < n; i++) {
        const ds = s[i]! - sMean;
        const db = b[i]! - bMean;
        cov += ds * db;
        varB += db * db;
        varS += ds * ds;
      }
      const denom = n - 1;
      cov /= denom;
      varB /= denom;
      varS /= denom;

      const beta = varB > 0 ? cov / varB : 0;
      const sStd = Math.sqrt(Math.max(0, varS));
      const bStd = Math.sqrt(Math.max(0, varB));
      const correlation = sStd > 0 && bStd > 0 ? cov / (sStd * bStd) : 0;
      const r2 = Math.min(1, Math.max(0, correlation * correlation));

      const sqrtYear = Math.sqrt(TRADING_DAYS_PER_YEAR);
      const stockAnnualizedVol = sStd * sqrtYear;
      const benchmarkAnnualizedVol = bStd * sqrtYear;
      const systematicVol = Math.sqrt(r2) * stockAnnualizedVol;
      const idiosyncraticVol = Math.sqrt(1 - r2) * stockAnnualizedVol;

      // Regime split on benchmark direction.
      const sUp: number[] = [];
      const bUp: number[] = [];
      const sDown: number[] = [];
      const bDown: number[] = [];
      for (let i = 0; i < n; i++) {
        if (b[i]! > 0) {
          sUp.push(s[i]!);
          bUp.push(b[i]!);
        } else if (b[i]! < 0) {
          sDown.push(s[i]!);
          bDown.push(b[i]!);
        }
      }

      const bullBetaRaw =
        bUp.length >= MIN_REGIME_DAYS ? regressBeta(sUp, bUp) : null;
      const bearBetaRaw =
        bDown.length >= MIN_REGIME_DAYS ? regressBeta(sDown, bDown) : null;
      const bullBeta = bullBetaRaw === null ? null : round(bullBetaRaw, 3);
      const bearBeta = bearBetaRaw === null ? null : round(bearBetaRaw, 3);
      const downsideAsymmetry =
        bullBeta !== null && bearBeta !== null
          ? round(bearBeta - bullBeta, 3)
          : null;

      // Capture ratios: mean stock return ÷ mean benchmark return on those days.
      const bUpMean = mean(bUp);
      const bDownMean = mean(bDown);
      const upCapture =
        bUp.length >= MIN_REGIME_DAYS && bUpMean !== 0
          ? round(mean(sUp) / bUpMean, 3)
          : null;
      const downCapture =
        bDown.length >= MIN_REGIME_DAYS && bDownMean !== 0
          ? round(mean(sDown) / bDownMean, 3)
          : null;

      // Rolling (recent) beta vs full-window beta → trend.
      let rollingBetaRecent: number | null = null;
      let betaTrend: BetaDecompositionResult["betaTrend"] = "stable";
      if (n >= ROLLING_WINDOW) {
        const recent = regressBeta(s.slice(-ROLLING_WINDOW), b.slice(-ROLLING_WINDOW));
        if (recent !== null) {
          rollingBetaRecent = round(recent, 3);
          const diff = recent - beta;
          if (diff > 0.15) betaTrend = "rising";
          else if (diff < -0.15) betaTrend = "falling";
          else betaTrend = "stable";
        }
      }

      const sensitivity: BetaDecompositionResult["sensitivity"] =
        beta < 0.85 ? "defensive" : beta > 1.15 ? "aggressive" : "market";

      // Observations only — no recommendations (SEBI compliance).
      const observationsText: string[] = [];
      observationsText.push(
        `Overall beta of ${round(beta, 2)} vs benchmark (${sensitivity} sensitivity).`,
      );
      observationsText.push(
        `R² of ${round(r2, 2)} — ${Math.round(r2 * 100)}% of return variance is market-driven; the remaining ${Math.round((1 - r2) * 100)}% is stock-specific.`,
      );
      if (downsideAsymmetry !== null && downsideAsymmetry > 0.2) {
        observationsText.push(
          `Bear-day beta (${bearBeta}) exceeds bull-day beta (${bullBeta}) — historically fell harder than it rose.`,
        );
      } else if (downsideAsymmetry !== null && downsideAsymmetry < -0.2) {
        observationsText.push(
          `Bull-day beta (${bullBeta}) exceeds bear-day beta (${bearBeta}) — historically captured more upside than downside.`,
        );
      }
      if (upCapture !== null && downCapture !== null) {
        observationsText.push(
          `Up-capture ${upCapture} / down-capture ${downCapture} on benchmark up/down days.`,
        );
      }
      if (rollingBetaRecent !== null && betaTrend !== "stable") {
        observationsText.push(
          `Recent ${ROLLING_WINDOW}-obs beta (${rollingBetaRecent}) is ${betaTrend} relative to the full-window beta (${round(beta, 2)}).`,
        );
      }

      const result: BetaDecompositionResult = {
        available: true,
        symbol,
        observations: n,
        beta: round(beta, 3),
        correlation: round(correlation, 3),
        r2: round(r2, 3),
        stockAnnualizedVol: round(stockAnnualizedVol, 4),
        benchmarkAnnualizedVol: round(benchmarkAnnualizedVol, 4),
        systematicVol: round(systematicVol, 4),
        idiosyncraticVol: round(idiosyncraticVol, 4),
        bullBeta,
        bearBeta,
        downsideAsymmetry,
        upCapture,
        downCapture,
        rollingBetaRecent,
        betaTrend,
        sensitivity,
        observationsText,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Beta decomposition failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
