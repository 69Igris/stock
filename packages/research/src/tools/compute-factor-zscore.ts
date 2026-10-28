/**
 * Cross-Sectional Factor Z-Scores (MONEY-498)
 *
 * Given a subject company and a peer set, builds the cross-section
 * (subject + peers) per comparable factor, computes the mean and the
 * sample standard deviation, and reports the subject's z-score
 * z = (subject - mean) / stdev — orienting each factor so that a HIGHER
 * z always means "better than peers" (lower-is-better metrics like PE/PB
 * /debt are sign-flipped before the z is taken). Also reports a
 * percentile rank of the subject within the peer set per factor, the
 * usable peer count per factor, and the factors where the subject sits in
 * the top quartile of its peer group.
 *
 * PURE compute tool — no network/db/io. Inputs are injected by the
 * executor from upstream fetch results:
 *   - `subjectFactors` ← the whole `compute_factor_scores` result
 *     (per-factor 0-100 scores AND/OR raw metric values).
 *   - `peers`          ← the `fetch_peer_companies` result array
 *     (each peer carries comparable raw metrics: pe, pb, roe, netMargin,
 *      revenueGrowth, …).
 *
 * Graceful degradation: when fewer than 3 peers carry usable data for a
 * factor (and overall), returns { available: false, reason } so the
 * synthesizer renders an honest "—" rather than fabricating a z-score.
 *
 * SEBI: observations / scores / flags only. No buy/sell/hold/target advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result interface ────────────────────────────────────────────

export interface FactorZscore {
  /** Canonical factor key (e.g. "roe", "pe", "netMargin"). */
  factor: string;
  /** Subject's raw value for the factor (as fed in), null if unusable. */
  subjectValue: number | null;
  /** Peer cross-section mean of the raw values. */
  peerMean: number;
  /** Sample standard deviation (n-1) of the cross-section. */
  peerStdev: number;
  /**
   * Orientation-adjusted z-score. Higher = better than peers regardless of
   * whether the underlying metric is higher- or lower-is-better. null when
   * stdev is 0 (no dispersion) or data is insufficient.
   */
  zScore: number | null;
  /** Whether this factor is higher-is-better (false ⇒ lower-is-better). */
  higherIsBetter: boolean;
  /** Subject's percentile rank within the peer set (0-100), null if N/A. */
  percentileRank: number | null;
  /** Peers contributing usable data to this factor's cross-section. */
  peerCount: number;
}

export interface FactorZscoreResult {
  available: boolean;
  /** Populated when available === false. */
  reason?: string;
  symbol: string;
  /** Per-factor z-scores and percentiles. */
  factors: FactorZscore[];
  /** Max usable peer count observed across factors. */
  peerCount: number;
  /** Factors where the subject's percentileRank >= 75 (top quartile). */
  topQuartileFactors: string[];
  /** Factors where the subject's percentileRank <= 25 (bottom quartile). */
  bottomQuartileFactors: string[];
  /** Neutral, SEBI-safe observations. */
  observations: string[];
}

// ─── Factor orientation registry ─────────────────────────────────

/**
 * Canonical comparable factors and whether HIGHER is better. Lower-is-better
 * metrics (valuation multiples, leverage, accruals) are sign-flipped before
 * the z-score so a positive z consistently reads as "ahead of peers".
 */
const FACTOR_ORIENTATION: Record<string, boolean> = {
  // Valuation — cheaper (lower) is better
  pe: false,
  peRatio: false,
  pb: false,
  pbRatio: false,
  evEbitda: false,
  priceToSales: false,
  // Profitability — higher is better
  roe: true,
  roce: true,
  roa: true,
  netMargin: true,
  operatingMargin: true,
  grossMargin: true,
  ebitdaMargin: true,
  // Growth — higher is better
  revenueGrowth: true,
  revenueGrowthYoY: true,
  revenueCagr3y: true,
  epsGrowth: true,
  profitGrowth: true,
  // Balance sheet — lower leverage / higher coverage
  debtEquity: false,
  debtToEquity: false,
  currentRatio: true,
  interestCoverage: true,
  // Quality — higher cash backing better, lower accruals better
  cfNiRatio: true,
  accrualRatio: false,
  fcfYield: true,
  // Ownership — higher promoter holding better, lower pledge better
  promoterHolding: true,
  promoterPledge: false,
};

/** Aliases that map an incoming key onto a canonical factor key. */
const FACTOR_ALIASES: Record<string, string> = {
  "p/e": "pe",
  pe_ratio: "pe",
  "p/b": "pb",
  pb_ratio: "pb",
  returnonequity: "roe",
  return_on_equity: "roe",
  returnoncapitalemployed: "roce",
  net_margin: "netMargin",
  netprofitmargin: "netMargin",
  operating_margin: "operatingMargin",
  revenue_growth: "revenueGrowth",
  revenuegrowthyoy: "revenueGrowthYoY",
  eps_growth: "epsGrowth",
  "debt/equity": "debtEquity",
  debt_equity: "debtEquity",
  debttoequity: "debtEquity",
  current_ratio: "currentRatio",
  interest_coverage: "interestCoverage",
  promoter_holding: "promoterHolding",
  promoter_pledge: "promoterPledge",
};

// ─── Numeric helpers ─────────────────────────────────────────────

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[%,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample (n-1) standard deviation. Returns 0 for n < 2. */
function sampleStdev(values: number[], mu: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((s, v) => s + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function canonicalKey(key: string): string {
  const lower = key.toLowerCase();
  if (FACTOR_ALIASES[lower]) return FACTOR_ALIASES[lower];
  // Match a known canonical factor case-insensitively.
  for (const k of Object.keys(FACTOR_ORIENTATION)) {
    if (k.toLowerCase() === lower) return k;
  }
  return key;
}

/**
 * Extract a flat record of raw comparable metrics from the (possibly nested)
 * compute_factor_scores result. Accepts either a flat metrics object or one
 * with a `metrics` / `rawMetrics` / `factors` sub-object.
 */
function extractSubjectMetrics(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (input == null || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;

  const sources: Array<Record<string, unknown>> = [obj];
  for (const nestKey of ["metrics", "rawMetrics", "factors", "values"]) {
    const nested = obj[nestKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      sources.push(nested as Record<string, unknown>);
    }
  }

  for (const src of sources) {
    for (const [rawKey, rawVal] of Object.entries(src)) {
      const canon = canonicalKey(rawKey);
      if (!(canon in FACTOR_ORIENTATION)) continue;
      const num = toFiniteNumber(rawVal);
      // First usable value wins (top-level overrides nested).
      if (num !== null && !(canon in out)) out[canon] = num;
    }
  }
  return out;
}

/** Pull comparable raw metrics out of one peer object. */
function extractPeerMetrics(peer: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (peer == null || typeof peer !== "object") return out;
  for (const [rawKey, rawVal] of Object.entries(
    peer as Record<string, unknown>,
  )) {
    const canon = canonicalKey(rawKey);
    if (!(canon in FACTOR_ORIENTATION)) continue;
    const num = toFiniteNumber(rawVal);
    // Treat 0 PE/PB/marketCap-style placeholders as "no data" — many peer
    // sources zero-fill unknown columns (see fetch_peer_companies).
    if (num !== null && num !== 0 && !(canon in out)) out[canon] = num;
  }
  return out;
}

// ─── Tool ────────────────────────────────────────────────────────

export const computeFactorZscoreTool: ResearchToolDef = {
  name: "compute_factor_zscore",
  description:
    "Compute cross-sectional factor z-scores and percentile ranks for a subject vs its peer set (higher-is-better oriented). Observations only.",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Subject stock symbol (e.g., RELIANCE). Optional label.",
    },
    subjectFactors: {
      type: "object",
      description:
        "Whole compute_factor_scores result for the subject: per-factor 0-100 scores and/or raw metrics (pe, pb, roe, netMargin, revenueGrowth, debtEquity, …). May be flat or nest values under metrics/rawMetrics/factors.",
      required: true,
    },
    peers: {
      type: "object[]",
      description:
        "fetch_peer_companies result array. Each peer carries comparable raw metrics (pe, pb, roe, netMargin, revenueGrowth, …). Need >=3 peers with usable data per factor.",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol = (
      typeof params.symbol === "string" ? params.symbol : ""
    )
      .replace(/\.(NS|BO)$/i, "")
      .toUpperCase();

    try {
      const subjectMetrics = extractSubjectMetrics(params.subjectFactors);

      const peersRaw = Array.isArray(params.peers)
        ? (params.peers as unknown[])
        : [];
      const peerMetrics = peersRaw
        .map((p) => extractPeerMetrics(p))
        .filter((m) => Object.keys(m).length > 0);

      // Honest "—": need a minimum cross-section to compute meaningful
      // dispersion. Fewer than 3 peers with usable data → degrade.
      if (peerMetrics.length < 3) {
        return {
          success: true,
          data: {
            available: false,
            reason: `Insufficient peer data: need >=3 peers with comparable metrics, found ${peerMetrics.length}`,
            symbol,
            factors: [],
            peerCount: peerMetrics.length,
            topQuartileFactors: [],
            bottomQuartileFactors: [],
            observations: [],
          } satisfies FactorZscoreResult,
        };
      }

      // Candidate factors = those present on the subject AND on enough peers.
      const candidateFactors = Object.keys(subjectMetrics).filter(
        (f) => f in FACTOR_ORIENTATION,
      );

      const factors: FactorZscore[] = [];
      const topQuartileFactors: string[] = [];
      const bottomQuartileFactors: string[] = [];
      const observations: string[] = [];

      for (const factor of candidateFactors) {
        const higherIsBetter = FACTOR_ORIENTATION[factor]!;
        const subjectValue = subjectMetrics[factor]!;

        const peerValues = peerMetrics
          .map((m) => m[factor])
          .filter((v): v is number => typeof v === "number");

        // Need >=3 peers with this specific factor to form a cross-section.
        if (peerValues.length < 3) continue;

        // Cross-section = subject + peers.
        const crossSection = [subjectValue, ...peerValues];
        const mu = mean(crossSection);
        const sigma = sampleStdev(crossSection, mu);

        // Orientation: flip sign so positive z always reads as "ahead".
        const rawZ = sigma > 0 ? (subjectValue - mu) / sigma : null;
        const zScore =
          rawZ === null ? null : round(higherIsBetter ? rawZ : -rawZ, 2);

        // Percentile rank of subject WITHIN the peer set (peers only).
        // Count peers the subject beats (orientation-aware), ties get half.
        let beats = 0;
        for (const pv of peerValues) {
          const subjectAhead = higherIsBetter
            ? subjectValue > pv
            : subjectValue < pv;
          const tie = subjectValue === pv;
          if (subjectAhead) beats += 1;
          else if (tie) beats += 0.5;
        }
        const percentileRank = round((beats / peerValues.length) * 100, 1);

        factors.push({
          factor,
          subjectValue: round(subjectValue, 4),
          peerMean: round(mu, 4),
          peerStdev: round(sigma, 4),
          zScore,
          higherIsBetter,
          percentileRank,
          peerCount: peerValues.length,
        });

        if (percentileRank >= 75) {
          topQuartileFactors.push(factor);
          observations.push(
            `${factor}: top-quartile vs peers (${percentileRank}th pct, z=${zScore ?? "n/a"})`,
          );
        } else if (percentileRank <= 25) {
          bottomQuartileFactors.push(factor);
          observations.push(
            `${factor}: bottom-quartile vs peers (${percentileRank}th pct, z=${zScore ?? "n/a"})`,
          );
        }
      }

      // No factor cleared the >=3-peer cross-section bar.
      if (factors.length === 0) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "No factor had both a subject value and >=3 peers with comparable data",
            symbol,
            factors: [],
            peerCount: peerMetrics.length,
            topQuartileFactors: [],
            bottomQuartileFactors: [],
            observations: [],
          } satisfies FactorZscoreResult,
        };
      }

      const result: FactorZscoreResult = {
        available: true,
        symbol,
        factors,
        peerCount: Math.max(...factors.map((f) => f.peerCount)),
        topQuartileFactors,
        bottomQuartileFactors,
        observations,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Factor z-score computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
