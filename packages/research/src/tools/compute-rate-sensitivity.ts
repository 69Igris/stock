/**
 * Compute Rate Sensitivity Tool
 *
 * Interest-rate sensitivity analysis for an Indian-listed company.
 *
 *   (a) Sector heuristic — classify a sector's sensitivity class
 *       (high/moderate/low) and the direction of a rate hike's impact
 *       (positive/negative/neutral). e.g. banks/financials benefit from
 *       rate-ups (NIM), while NBFC/realty/auto/capital-goods are hurt, and
 *       IT/pharma/FMCG are low-sensitivity defensives.
 *
 *   (b) Empirical rateBeta — if a repo-rate history and matching stock
 *       returns are supplied, regress stock returns on rate *changes* to get
 *       an observed beta (else null).
 *
 *   (c) Qualitative impact of a +/-25bps move for rate-sensitive sectors.
 *
 * PURE compute: no network/db/io. Macro inputs (repoRate, repoRateHistory)
 * are injected by the executor from fetch_macro_dashboard; sector from
 * fetch_company_profile.
 *
 * SEBI: observations / scores / flags only — no buy/sell/hold/target advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result Interface ────────────────────────────────────────

export interface RateSensitivityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  sector?: string;
  normalizedSector?: string;
  /** How strongly the sector reacts to rate moves. */
  sensitivityClass?: "high" | "moderate" | "low";
  /** Direction of impact when rates RISE (positive = helps, negative = hurts). */
  direction?: "positive" | "negative" | "neutral";
  /**
   * Empirical regression slope of stock returns on rate changes
   * (Δreturn per 1 percentage-point rate change). Null when no
   * empirical inputs were supplied.
   */
  rateBeta: number | null;
  /** R-squared of the empirical regression, null when not computed. */
  rateBetaR2?: number | null;
  /** Number of paired observations used for the regression. */
  empiricalSampleSize?: number;
  /** Current RBI repo rate (%) if known. */
  currentRepoRate?: number | null;
  /** Qualitative impact narrative for a +25bps and -25bps move. */
  rateMoveImpact?: {
    hike25bps: string;
    cut25bps: string;
  };
  /** Narrative drivers behind the classification. */
  drivers: string[];
  /** Observation flags. */
  flags: string[];
}

// ─── Sector Sensitivity Map ──────────────────────────────────
// direction = impact of a RATE HIKE on the sector.

interface SectorEntry {
  sensitivityClass: "high" | "moderate" | "low";
  direction: "positive" | "negative" | "neutral";
  driver: string;
}

const SECTOR_MAP: Record<string, SectorEntry> = {
  banking: {
    sensitivityClass: "high",
    direction: "positive",
    driver:
      "Banks generally see net interest margins (NIM) expand when rates rise, as lending rates reprice faster than deposit costs.",
  },
  nbfc: {
    sensitivityClass: "high",
    direction: "negative",
    driver:
      "NBFCs rely on wholesale borrowing; rate hikes raise their cost of funds faster than they can reprice loans, compressing spreads.",
  },
  realty: {
    sensitivityClass: "high",
    direction: "negative",
    driver:
      "Higher rates lift home-loan EMIs and construction-finance costs, directly dampening property demand — among the most rate-sensitive sectors.",
  },
  auto: {
    sensitivityClass: "high",
    direction: "negative",
    driver:
      "Most vehicle purchases are financed; higher EMIs reduce affordability and soften discretionary auto demand.",
  },
  "capital goods": {
    sensitivityClass: "high",
    direction: "negative",
    driver:
      "Capital-goods and infrastructure capex is debt-funded; rising rates raise project financing costs and defer investment cycles.",
  },
  metals: {
    sensitivityClass: "moderate",
    direction: "negative",
    driver:
      "Capital-intensive balance sheets carry meaningful debt, so financing costs rise; rate hikes also signal slowing demand.",
  },
  infrastructure: {
    sensitivityClass: "high",
    direction: "negative",
    driver:
      "Highly leveraged, long-gestation projects make infrastructure sensitive to higher borrowing costs.",
  },
  it: {
    sensitivityClass: "low",
    direction: "neutral",
    driver:
      "IT services carry minimal domestic debt and earn largely in foreign currency, leaving them broadly insulated from domestic rate moves.",
  },
  pharma: {
    sensitivityClass: "low",
    direction: "neutral",
    driver:
      "Healthcare demand is non-discretionary and leverage is moderate, making pharma a defensive, low-rate-sensitivity sector.",
  },
  fmcg: {
    sensitivityClass: "low",
    direction: "neutral",
    driver:
      "Low-leverage, inelastic-demand staples make FMCG a defensive sector with limited direct rate sensitivity.",
  },
  "oil & gas": {
    sensitivityClass: "moderate",
    direction: "negative",
    driver:
      "Capex-heavy energy firms carry large debt books, so higher financing costs weigh modestly on profitability.",
  },
  utilities: {
    sensitivityClass: "moderate",
    direction: "negative",
    driver:
      "Regulated, capital-intensive utilities carry high leverage, so debt-servicing costs rise with rates.",
  },
};

// Alias normalization → canonical sector keys above.
const SECTOR_ALIASES: Record<string, string> = {
  bank: "banking",
  banks: "banking",
  "private bank": "banking",
  "public sector bank": "banking",
  psu: "banking",
  finance: "banking",
  financial: "banking",
  financials: "banking",
  "financial services": "banking",
  finserv: "banking",

  "non banking financial": "nbfc",
  "non-banking financial": "nbfc",
  "housing finance": "nbfc",
  hfc: "nbfc",
  lending: "nbfc",

  "real estate": "realty",
  realestate: "realty",
  property: "realty",
  housing: "realty",
  construction: "realty",

  automobile: "auto",
  automotive: "auto",
  "auto ancillary": "auto",
  vehicles: "auto",

  "capital good": "capital goods",
  capitalgoods: "capital goods",
  engineering: "capital goods",
  industrials: "capital goods",
  machinery: "capital goods",

  steel: "metals",
  metal: "metals",
  mining: "metals",
  commodities: "metals",

  infra: "infrastructure",

  technology: "it",
  tech: "it",
  infotech: "it",
  software: "it",
  "information technology": "it",

  healthcare: "pharma",
  health: "pharma",
  pharmaceutical: "pharma",
  pharmaceuticals: "pharma",

  consumer: "fmcg",
  "consumer staples": "fmcg",
  "consumer goods": "fmcg",
  staples: "fmcg",

  oil: "oil & gas",
  energy: "oil & gas",
  petroleum: "oil & gas",
  "oil and gas": "oil & gas",
  oilandgas: "oil & gas",

  utility: "utilities",
  power: "utilities",
};

function normalizeSector(input: string): string {
  const lower = input.toLowerCase().trim();
  return SECTOR_ALIASES[lower] || lower;
}

// ─── Numeric helpers ─────────────────────────────────────────

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The macro snapshot may inject repoRate either as a bare number or as a
 * { value, date } MacroIndicator object. Accept both.
 */
function extractRepoRate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return toNumberOrNull(rec.value);
  }
  return toNumberOrNull(value);
}

/**
 * repoRateHistory entries may be bare numbers or { value }/{ rate } objects.
 */
function extractRateSeries(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    let n: number | null = null;
    if (typeof entry === "object" && entry !== null) {
      const rec = entry as Record<string, unknown>;
      n = toNumberOrNull(rec.value ?? rec.rate ?? rec.repoRate);
    } else {
      n = toNumberOrNull(entry);
    }
    if (n !== null) out.push(n);
  }
  return out;
}

function extractReturnSeries(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    let n: number | null = null;
    if (typeof entry === "object" && entry !== null) {
      const rec = entry as Record<string, unknown>;
      n = toNumberOrNull(rec.value ?? rec.return ?? rec.ret ?? rec.change);
    } else {
      n = toNumberOrNull(entry);
    }
    if (n !== null) out.push(n);
  }
  return out;
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * Ordinary least-squares regression of y on x.
 * Returns slope (beta), r-squared, and the sample size, or null when there
 * is insufficient variation / too few points.
 */
function linearRegression(
  x: number[],
  y: number[],
): { beta: number; r2: number; n: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;

  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx === 0) return null; // no variation in rate changes → undefined slope

  const beta = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  return { beta, r2, n };
}

// ─── Tool Definition ─────────────────────────────────────────

export const computeRateSensitivityTool: ResearchToolDef = {
  name: "compute_rate_sensitivity",
  description:
    "Classify a company's interest-rate sensitivity (class + direction) via sector heuristics, with optional empirical rate-beta regression",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE/BSE symbol (e.g., HDFCBANK), for labelling only",
    },
    sector: {
      type: "string",
      description:
        "Sector name from fetch_company_profile.sector (e.g., banking, nbfc, realty, auto, it, pharma, fmcg)",
    },
    repoRate: {
      type: "number",
      description:
        "Current RBI repo rate (%) from fetch_macro_dashboard.repoRate (accepts a number or a { value } indicator object)",
    },
    repoRateHistory: {
      type: "array",
      description:
        "Optional historical repo-rate series (oldest → newest), aligned period-for-period with stockReturns; used for empirical rate-beta",
    },
    stockReturns: {
      type: "array",
      description:
        "Optional stock return series (%) aligned period-for-period with repoRateHistory; used for empirical rate-beta",
    },
  },
  // No cacheTTL: pure computation, cheap to re-run.
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" && params.symbol.trim()
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const rawSector =
        typeof params.sector === "string" && params.sector.trim()
          ? params.sector.trim()
          : undefined;

      const currentRepoRate = extractRepoRate(params.repoRate);

      const rateSeries = extractRateSeries(params.repoRateHistory);
      const returnSeries = extractReturnSeries(params.stockReturns);

      // ── (b) Empirical rate-beta: regress returns on rate CHANGES ──
      let rateBeta: number | null = null;
      let rateBetaR2: number | null = null;
      let empiricalSampleSize = 0;

      if (rateSeries.length >= 2 && returnSeries.length >= 1) {
        // Rate changes are period-over-period diffs; the first return aligns
        // with the change from period 0 → 1, so trim returns to match.
        const rateChanges: number[] = [];
        for (let i = 1; i < rateSeries.length; i++) {
          rateChanges.push(rateSeries[i]! - rateSeries[i - 1]!);
        }
        // Align: returnSeries[i] corresponds to rateChanges[i]. If the caller
        // passed one extra leading return (level-aligned), drop it.
        let alignedReturns = returnSeries;
        if (returnSeries.length === rateSeries.length) {
          alignedReturns = returnSeries.slice(1);
        }
        const reg = linearRegression(rateChanges, alignedReturns);
        if (reg) {
          rateBeta = round(reg.beta, 3);
          rateBetaR2 = round(reg.r2, 3);
          empiricalSampleSize = reg.n;
        }
      }

      // ── (a) Sector heuristic ──
      const normalizedSector = rawSector
        ? normalizeSector(rawSector)
        : undefined;
      const sectorEntry = normalizedSector
        ? SECTOR_MAP[normalizedSector]
        : undefined;

      // Graceful degradation: no sector AND no empirical signal.
      if (!sectorEntry && rateBeta === null) {
        return {
          success: true,
          data: {
            available: false,
            reason: rawSector
              ? `Sector "${rawSector}" is not in the rate-sensitivity map and no empirical return/rate series was provided`
              : "No sector classification and no empirical return/rate series provided",
            symbol,
            sector: rawSector,
            normalizedSector,
            rateBeta: null,
            drivers: [],
            flags: [],
          } satisfies RateSensitivityResult,
        };
      }

      const drivers: string[] = [];
      const flags: string[] = [];

      let sensitivityClass: RateSensitivityResult["sensitivityClass"];
      let direction: RateSensitivityResult["direction"];

      if (sectorEntry) {
        sensitivityClass = sectorEntry.sensitivityClass;
        direction = sectorEntry.direction;
        drivers.push(sectorEntry.driver);
      } else if (rateBeta !== null) {
        // No sector mapping — infer from empirical beta alone.
        const absBeta = Math.abs(rateBeta);
        sensitivityClass =
          absBeta >= 3 ? "high" : absBeta >= 1 ? "moderate" : "low";
        direction =
          rateBeta > 0.5 ? "positive" : rateBeta < -0.5 ? "negative" : "neutral";
        drivers.push(
          "Sector classification unavailable; sensitivity inferred from the empirical rate-beta only.",
        );
      } else {
        sensitivityClass = "low";
        direction = "neutral";
      }

      // ── (c) Qualitative +/-25bps impact (rate-sensitive sectors) ──
      const dirVerb =
        direction === "positive"
          ? { hike: "a tailwind", cut: "a mild headwind" }
          : direction === "negative"
            ? { hike: "a headwind", cut: "a tailwind" }
            : { hike: "broadly neutral", cut: "broadly neutral" };

      const rateMoveImpact = {
        hike25bps:
          sensitivityClass === "low"
            ? "A +25bps hike is expected to have limited direct impact (low-sensitivity sector)."
            : `A +25bps hike is observed as ${dirVerb.hike} for this ${sensitivityClass}-sensitivity sector.`,
        cut25bps:
          sensitivityClass === "low"
            ? "A -25bps cut is expected to have limited direct impact (low-sensitivity sector)."
            : `A -25bps cut is observed as ${dirVerb.cut} for this ${sensitivityClass}-sensitivity sector.`,
      };

      // ── Empirical corroboration / divergence flags ──
      if (rateBeta !== null) {
        drivers.push(
          `Empirical rate-beta of ${rateBeta} (R²=${rateBetaR2}, n=${empiricalSampleSize}) estimated by regressing stock returns on repo-rate changes.`,
        );
        if (rateBetaR2 !== null && rateBetaR2 < 0.1) {
          flags.push(
            `Empirical rate-beta has low explanatory power (R²=${rateBetaR2}) — treat the regression as indicative only.`,
          );
        }
        if (empiricalSampleSize < 6) {
          flags.push(
            `Empirical rate-beta is based on a small sample (n=${empiricalSampleSize}) — low statistical confidence.`,
          );
        }
        if (sectorEntry && direction !== "neutral") {
          const empiricalDir =
            rateBeta > 0.1 ? "positive" : rateBeta < -0.1 ? "negative" : "neutral";
          if (empiricalDir !== "neutral" && empiricalDir !== direction) {
            flags.push(
              `Empirical rate-beta direction (${empiricalDir}) diverges from the sector heuristic (${direction}) — company-specific factors may dominate.`,
            );
          }
        }
      } else {
        flags.push(
          "No empirical rate-beta computed (insufficient repo-rate history / return series) — classification is heuristic-only.",
        );
      }

      if (sensitivityClass === "high") {
        flags.push(
          "High rate-sensitivity sector — earnings and valuation are observed to react materially to RBI policy shifts.",
        );
      }

      if (currentRepoRate !== null) {
        drivers.push(
          `Current RBI repo rate referenced at ${currentRepoRate}%.`,
        );
      }

      const result: RateSensitivityResult = {
        available: true,
        symbol,
        sector: rawSector,
        normalizedSector,
        sensitivityClass,
        direction,
        rateBeta,
        rateBetaR2,
        empiricalSampleSize,
        currentRepoRate,
        rateMoveImpact,
        drivers,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: {
          source: "Sector rate-sensitivity heuristics + OLS rate-beta",
          empirical: rateBeta !== null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Rate sensitivity computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
