/**
 * Composite Quant Score
 *
 * Blends per-factor scores (value, quality, momentum, growth, lowVol) into a
 * single 0-100 composite quant score using weights that renormalize over the
 * factors actually present. Produces a percentile, the dominant factor, a
 * human-readable style label (e.g. "High-Quality Momentum"), a per-factor
 * contribution breakdown, and an observation-only scored card.
 *
 * PURE compute tool: reads everything from params (fed by the executor from
 * compute_factor_scores + optionally compute_factor_zscore). No io.
 *
 * SEBI compliance: emits observations / scores / labels only. No buy/sell/hold
 * or target-price language. UseMoney is not a SEBI-registered Research Analyst.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

/** The five quant style factors blended into the composite. */
type FactorKey = "value" | "quality" | "momentum" | "growth" | "lowVol";

const FACTOR_KEYS: readonly FactorKey[] = [
  "value",
  "quality",
  "momentum",
  "growth",
  "lowVol",
] as const;

const DEFAULT_WEIGHTS: Record<FactorKey, number> = {
  value: 0.25,
  quality: 0.3,
  momentum: 0.2,
  growth: 0.15,
  lowVol: 0.1,
};

/** Per-factor contribution to the composite score. */
export interface FactorContribution {
  factor: FactorKey;
  score: number; // 0-100 normalized factor score used in the blend
  zscore: number | null; // cross-sectional z-score if supplied, else null
  weight: number; // renormalized weight (0-1) over available factors
  contribution: number; // points this factor added to the composite (0-100)
  contributionPercent: number; // share of total composite (0-100)
}

export interface CompositeQuantScoredCard {
  rating: "Strong" | "Above-Average" | "Average" | "Below-Average" | "Weak";
  score: number; // 0-100 composite, mirrors top-level composite
  summary: string; // observation-only one-liner
}

export interface CompositeQuantScoreResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  composite: number; // 0-100 blended quant score
  percentile: number; // 0-100 approximate cross-sectional percentile
  dominantFactor: FactorKey | null; // factor contributing the most
  styleLabel: string; // e.g. "High-Quality Momentum"
  factorsUsed: FactorKey[]; // factors that had data and entered the blend
  contributions: FactorContribution[];
  scoredCard: CompositeQuantScoredCard;
  flags: string[];
}

/**
 * Pull a 0-100 factor score for `key` out of an arbitrary upstream result.
 * Supports several common shapes without throwing:
 *   { scores: { value: 70, ... } }
 *   { factorScores: { value: 70, ... } }
 *   { value: 70, ... }
 *   { factors: [{ factor: "value", score: 70 }, ...] }
 */
function readFactorScore(
  source: Record<string, unknown> | null,
  key: FactorKey,
): number | null {
  if (!source) return null;

  // Nested score maps in priority order.
  const nestedCandidates: unknown[] = [
    source.scores,
    source.factorScores,
    source.factors,
  ];
  for (const candidate of nestedCandidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const v = (candidate as Record<string, unknown>)[key];
      const n = coerceScore(v);
      if (n !== null) return n;
    }
  }

  // Array-of-objects shape: [{ factor: "value", score: 70 }, ...]
  if (Array.isArray(source.factors)) {
    for (const entry of source.factors) {
      if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        if (rec.factor === key || rec.name === key) {
          const n = coerceScore(rec.score ?? rec.value);
          if (n !== null) return n;
        }
      }
    }
  }

  // Flat shape on the root.
  return coerceScore(source[key]);
}

/** Coerce a maybe-numeric value into a finite 0-100 score, else null. */
function coerceScore(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(0, Math.min(100, v));
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }
  // Object holding a `.score` (e.g. { score: 70, weight: 0.2 }).
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).score;
    if (typeof inner === "number" && Number.isFinite(inner)) {
      return Math.max(0, Math.min(100, inner));
    }
  }
  return null;
}

/** Coerce a maybe-numeric value into a finite z-score, else null. */
function coerceZ(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).zscore ?? (v as Record<string, unknown>).z;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  return null;
}

function readFactorZscore(
  source: Record<string, unknown> | null,
  key: FactorKey,
): number | null {
  if (!source) return null;
  const nestedCandidates: unknown[] = [
    source.zscores,
    source.factorZscores,
    source.scores,
    source.factors,
  ];
  for (const candidate of nestedCandidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const z = coerceZ((candidate as Record<string, unknown>)[key]);
      if (z !== null) return z;
    }
  }
  if (Array.isArray(source.factors)) {
    for (const entry of source.factors) {
      if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        if (rec.factor === key || rec.name === key) {
          const z = coerceZ(rec.zscore ?? rec.z);
          if (z !== null) return z;
        }
      }
    }
  }
  return coerceZ(source[key]);
}

/** Human-readable factor adjectives for the style label. */
const FACTOR_LABELS: Record<FactorKey, { high: string; noun: string }> = {
  value: { high: "Deep-Value", noun: "Value" },
  quality: { high: "High-Quality", noun: "Quality" },
  momentum: { high: "Strong-Momentum", noun: "Momentum" },
  growth: { high: "High-Growth", noun: "Growth" },
  lowVol: { high: "Low-Volatility", noun: "Defensive" },
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export const computeCompositeQuantScoreTool: ResearchToolDef = {
  name: "compute_composite_quant_score",
  description:
    "Blend factor scores (value, quality, momentum, growth, lowVol) into one 0-100 composite quant score with weights, percentile, dominant factor, style label, and contribution breakdown",
  category: "computation",
  parameters: {
    factorScores: {
      type: "object",
      description:
        "Whole result from compute_factor_scores — per-factor 0-100 scores for value, quality, momentum, growth, lowVol",
      required: true,
    },
    factorZscores: {
      type: "object",
      description:
        "Optional whole result from compute_factor_zscore — cross-sectional z-scores per factor, used to refine the percentile",
    },
    weights: {
      type: "object",
      description:
        "Optional factor weights (default: value 0.25, quality 0.30, momentum 0.20, growth 0.15, lowVol 0.10). Renormalized over factors that have data.",
    },
    symbol: {
      type: "string",
      description: "Symbol being scored (for labelling only)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol = ((params.symbol as string) || "").trim() || undefined;
      const factorScores = asRecord(params.factorScores);
      const factorZscores = asRecord(params.factorZscores);

      // If the upstream factor tool explicitly degraded, propagate honestly.
      if (factorScores && factorScores.available === false) {
        return {
          success: true,
          data: degraded(
            "Upstream factor scores unavailable",
            symbol,
          ),
        };
      }

      // Collect the factors that actually have a usable score.
      const present: {
        factor: FactorKey;
        score: number;
        zscore: number | null;
      }[] = [];
      for (const key of FACTOR_KEYS) {
        const score = readFactorScore(factorScores, key);
        if (score !== null) {
          present.push({
            factor: key,
            score,
            zscore: readFactorZscore(factorZscores, key),
          });
        }
      }

      if (present.length === 0) {
        return {
          success: true,
          data: degraded(
            "No underlying factor scores supplied — cannot compute a composite quant score",
            symbol,
          ),
        };
      }

      // Resolve weights: defaults overridden by params, then renormalized
      // over only the factors that are present so they sum to 1.
      const overrides = asRecord(params.weights) ?? {};
      const rawWeights: Record<FactorKey, number> = { ...DEFAULT_WEIGHTS };
      for (const key of FACTOR_KEYS) {
        const v = overrides[key];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
          rawWeights[key] = v;
        }
      }
      const weightSum = present.reduce(
        (acc, p) => acc + rawWeights[p.factor],
        0,
      );
      // If all present factors carry zero weight, fall back to equal weights.
      const useEqual = weightSum <= 0;
      const equalWeight = 1 / present.length;

      const contributions: FactorContribution[] = present.map((p) => {
        const weight = useEqual
          ? equalWeight
          : rawWeights[p.factor] / weightSum;
        const contribution = p.score * weight;
        return {
          factor: p.factor,
          score: round2(p.score),
          zscore: p.zscore === null ? null : round2(p.zscore),
          weight: round4(weight),
          contribution: round2(contribution),
          contributionPercent: 0, // filled after composite known
        };
      });

      const composite = clampScore(
        contributions.reduce((acc, c) => acc + c.contribution, 0),
      );

      // Contribution share of the composite.
      for (const c of contributions) {
        c.contributionPercent =
          composite > 0 ? round2((c.contribution / composite) * 100) : 0;
      }

      // Dominant factor = largest absolute contribution to the composite.
      const dominant = contributions.reduce((best, c) =>
        c.contribution > best.contribution ? c : best,
      );
      const dominantFactor = dominant.factor;

      // Percentile: prefer a z-score-implied percentile when z-scores were
      // supplied (weighted-average z across present factors), else fall back
      // to treating the composite score itself as a percentile proxy.
      const percentile = estimatePercentile(contributions, composite);

      const styleLabel = buildStyleLabel(present, contributions);

      const flags = buildFlags(present, composite);

      const scoredCard: CompositeQuantScoredCard = {
        rating: ratingFor(composite),
        score: composite,
        summary: buildSummary(
          symbol,
          composite,
          ratingFor(composite),
          styleLabel,
          dominantFactor,
          present.length,
        ),
      };

      const result: CompositeQuantScoreResult = {
        available: true,
        symbol,
        composite,
        percentile,
        dominantFactor,
        styleLabel,
        factorsUsed: present.map((p) => p.factor),
        contributions,
        scoredCard,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Composite quant score computation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};

/** Build the graceful-degradation payload. */
function degraded(
  reason: string,
  symbol: string | undefined,
): CompositeQuantScoreResult {
  return {
    available: false,
    reason,
    symbol,
    composite: 0,
    percentile: 0,
    dominantFactor: null,
    styleLabel: "Insufficient Factor Data",
    factorsUsed: [],
    contributions: [],
    scoredCard: {
      rating: "Average",
      score: 0,
      summary: reason,
    },
    flags: [],
  };
}

function clampScore(v: number): number {
  return Math.round(Math.max(0, Math.min(100, v)) * 100) / 100;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Approximate cross-sectional percentile. When z-scores are present, convert
 * a weighted-average z into a percentile via the standard normal CDF. Without
 * z-scores, the composite score (already 0-100) doubles as a percentile proxy.
 */
function estimatePercentile(
  contributions: FactorContribution[],
  composite: number,
): number {
  const withZ = contributions.filter((c) => c.zscore !== null);
  if (withZ.length === 0) {
    return Math.round(composite);
  }
  const wSum = withZ.reduce((acc, c) => acc + c.weight, 0);
  if (wSum <= 0) return Math.round(composite);
  const avgZ =
    withZ.reduce((acc, c) => acc + (c.zscore as number) * c.weight, 0) / wSum;
  const pct = normalCdf(avgZ) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normalCdf(z: number): number {
  // 0.5 * (1 + erf(z / sqrt(2)))
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — max abs error ~1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function ratingFor(score: number): CompositeQuantScoredCard["rating"] {
  if (score >= 80) return "Strong";
  if (score >= 65) return "Above-Average";
  if (score >= 45) return "Average";
  if (score >= 30) return "Below-Average";
  return "Weak";
}

/**
 * Build a style label from the strongest 1-2 factors, e.g.
 *   "High-Quality Momentum", "Deep-Value Defensive", "High-Quality".
 * A factor only contributes its adjective/noun if its raw score is strong
 * (>= 60). Otherwise the label reports a balanced/neutral profile.
 */
function buildStyleLabel(
  present: { factor: FactorKey; score: number }[],
  contributions: FactorContribution[],
): string {
  // Rank by contribution to the composite.
  const ranked = [...contributions].sort(
    (a, b) => b.contribution - a.contribution,
  );
  const scoreMap = new Map<FactorKey, number>(
    present.map((p) => [p.factor, p.score]),
  );

  const strong = ranked.filter((c) => (scoreMap.get(c.factor) ?? 0) >= 60);

  if (strong.length === 0) {
    return "Balanced / No Dominant Factor";
  }

  const top = strong[0]!.factor;
  if (strong.length === 1) {
    return FACTOR_LABELS[top].high;
  }

  const second = strong[1]!.factor;
  // "<Adjective of top> <Noun of second>", e.g. "High-Quality Momentum".
  return `${FACTOR_LABELS[top].high} ${FACTOR_LABELS[second].noun}`;
}

function buildFlags(
  present: { factor: FactorKey; score: number }[],
  composite: number,
): string[] {
  const flags: string[] = [];
  const missing = FACTOR_KEYS.filter(
    (k) => !present.some((p) => p.factor === k),
  );
  if (missing.length > 0) {
    flags.push(
      `Composite computed over ${present.length}/${FACTOR_KEYS.length} factors — weights renormalized (missing: ${missing.join(", ")})`,
    );
  }
  const weak = present.filter((p) => p.score < 30).map((p) => p.factor);
  if (weak.length > 0) {
    flags.push(`Weak factor exposure observed in: ${weak.join(", ")}`);
  }
  if (composite >= 80) {
    flags.push("Top-decile composite factor profile observed");
  } else if (composite < 30) {
    flags.push("Bottom-tier composite factor profile observed");
  }
  return flags;
}

function buildSummary(
  symbol: string | undefined,
  composite: number,
  rating: CompositeQuantScoredCard["rating"],
  styleLabel: string,
  dominantFactor: FactorKey | null,
  factorCount: number,
): string {
  const subject = symbol ? symbol : "The stock";
  const dom = dominantFactor ? FACTOR_LABELS[dominantFactor].noun : "no single";
  return `${subject} scores ${composite}/100 on the composite quant blend (${rating}), with a ${styleLabel} profile driven mainly by the ${dom} factor across ${factorCount} measured factor${factorCount === 1 ? "" : "s"}.`;
}
