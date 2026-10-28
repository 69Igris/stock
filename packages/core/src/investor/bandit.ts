/**
 * Outcome bandit — closes the self-improvement loop on the investor memory
 * system (MONEY-791, B6).
 *
 * The B1-B5 layers seed a profile, track concept mastery, and inject an
 * investor-memory block into the chat + research prompts. B6 adds the missing
 * feedback edge: which *framing* of an answer actually earned a 👍? We model
 * the choice of explanation framing as a multi-armed bandit over a small set of
 * {@link Variant} arms, each with Beta(α, β) reward statistics primed from the
 * REAL per-variant 👍/👎 win-rates recorded in `ResultFeedback`.
 *
 * Ported from orvi `packages/adaptive/src/{priors,planner}.ts` and pared down to
 * the investing surface: orvi's full style × modality × difficulty grid collapses
 * to a flat set of explanation-framing variants (concise / detailed / visual),
 * and the reward signal is a binary thumbs outcome rather than a mastery gain.
 *
 * Everything here is a PURE function — no I/O, no DB import, and (critically) NO
 * `Math.random` at module scope. Randomness is INJECTED (`Rng`) so the planner
 * is fully deterministic in tests; without an rng, selection is the deterministic
 * argmax of the posterior mean. The prisma-backed DB seam lives in
 * `./bandit-select.ts`.
 */

/** Pluggable RNG returning a float in [0,1). Injected for deterministic tests. */
export type Rng = () => number;

/**
 * One explanation-framing arm. `id` is the stable identity persisted as the
 * `metadata.variantId` tag on a `ResultFeedback` row, so a caller can later
 * aggregate outcomes back to the arm that produced them.
 */
export interface Variant {
  /** Stable arm id, e.g. "concise" — persisted as `metadata.variantId`. */
  id: string;
  /** Short human label for logs / rationales. */
  label: string;
  /** One-line description of the framing this arm applies. */
  description: string;
}

/**
 * The explanation-STYLE variants the bandit chooses between. These describe how
 * StockSage *frames* an answer — they NEVER change the regulated content (no
 * variant adds a buy/sell directive). `detailed` is the safe default when there
 * is no signal (see {@link DEFAULT_VARIANT_ID}).
 */
export const EXPLANATION_VARIANTS: readonly Variant[] = [
  {
    id: "concise",
    label: "Concise",
    description:
      "A tight, to-the-point explanation: the answer first, minimal preamble.",
  },
  {
    id: "detailed",
    label: "Detailed",
    description:
      "A thorough, step-by-step explanation that shows the reasoning and the figures it rests on.",
  },
  {
    id: "visual",
    label: "Visual",
    description:
      "A structure-forward explanation that leans on tables, bullet breakdowns, and labelled comparisons.",
  },
] as const;

/** The framing returned when there is no win-rate signal yet. */
export const DEFAULT_VARIANT_ID = "detailed";

/**
 * Short, bounded, SEBI-safe "explanation style" directive for a chosen variant
 * id (B6, MONEY-800). This is the ONLY thing the bandit injects into the prompt:
 * it nudges HOW the answer is framed (concise / structure-forward), NEVER what it
 * says — it can't add a buy/sell/hold directive or change the regulated content.
 *
 * Returns "" for the {@link DEFAULT_VARIANT_ID} ("detailed") and any unknown id,
 * so the prompt is UNCHANGED whenever the bandit falls back to the default (no
 * signal yet) — cold-start framing is identical to today. Only a deliberate
 * deviation from that natural, thorough default (concise / visual) emits a
 * directive.
 *
 * PURE — no I/O, safe to call from the (client-bundleable) chat prompt builder.
 */
export function variantStyleDirective(variantId: string | undefined): string {
  switch (variantId) {
    case "concise":
      return "Answer concisely: lead with the answer, keep preamble minimal.";
    case "visual":
      return "Favour structure: use short bullet breakdowns, tables, and labelled comparisons where they aid clarity.";
    default:
      // "detailed" (the default arm) + unknown ids → no directive; the model's
      // natural, thorough framing stands and the prompt is unchanged.
      return "";
  }
}

/** Beta(α, β) reward statistics for one variant arm. */
export interface BetaArm {
  /** Beta α: 1 + pseudo-successes (👍). */
  alpha: number;
  /** Beta β: 1 + pseudo-failures (👎). */
  beta: number;
}

/** Cap on how much a single variant's evidence can dominate the prior. */
export const MAX_PSEUDO_OBSERVATIONS = 50;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Fold a measured (winRate, impressions) signal into an informed Beta(α, β)
 * prior — orvi's `Beta(1 + w·n, 1 + (1 − w)·n)`.
 *
 * Recovers the uniform Beta(1,1) prior when `impressions = 0`, and concentrates
 * as evidence accrues (capped at {@link MAX_PSEUDO_OBSERVATIONS} so one heavily
 * observed arm can't permanently freeze out exploration).
 *
 * @param wins        number of 👍 outcomes for this variant.
 * @param impressions total outcomes (👍 + 👎) for this variant.
 */
export function armFromWinRate(wins: number, impressions: number): BetaArm {
  const n = Math.min(
    MAX_PSEUDO_OBSERVATIONS,
    Math.max(0, Number.isFinite(impressions) ? impressions : 0),
  );
  const w =
    n > 0 ? clamp01((Number.isFinite(wins) ? wins : 0) / impressions) : 0;
  return {
    alpha: 1 + w * n,
    beta: 1 + (1 - w) * n,
  };
}

/** Posterior mean reward of a Beta arm: α / (α + β). */
export function betaMean(arm: BetaArm): number {
  const denom = arm.alpha + arm.beta;
  return denom > 0 ? arm.alpha / denom : 0.5;
}

/**
 * Sample from Beta(α, β) using two Gamma samples (Marsaglia–Tsang for shape ≥ 1,
 * with a boost transform for shape < 1). Deterministic given the injected `rng`.
 * Used for Thompson sampling when an `rng` is supplied to {@link selectVariant}.
 */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Boost: Gamma(shape) = Gamma(shape + 1) · U^(1/shape).
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded loop so a pathological RNG can never hang the planner.
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      // Box–Muller for a standard normal from two uniforms.
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Fallback to the mean if rejection sampling never accepted.
  return shape;
}

/** Sample a reward in [0,1] from Beta(α, β). Deterministic given `rng`. */
export function sampleBeta(arm: BetaArm, rng: Rng): number {
  const x = sampleGamma(arm.alpha, rng);
  const y = sampleGamma(arm.beta, rng);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

/** Aggregated outcome statistics for one variant. */
export interface VariantWinRate {
  wins: number;
  impressions: number;
  winRate: number;
}

/** A single observed outcome row (what a caller derives from `ResultFeedback`). */
export interface OutcomeRow {
  variantId: string;
  outcome: "UP" | "DOWN";
}

/**
 * PURE aggregation: roll a list of per-result thumbs outcomes up into
 * per-variant win-rates. This is exactly what {@link pickExplanationVariant}
 * computes from the raw `ResultFeedback` rows before priming the bandit.
 *
 * Rows with an empty / missing `variantId` are ignored (untagged answers carry
 * no arm signal). The returned map keys are the variant ids seen in the data.
 */
export function computeVariantWinRates(
  rows: OutcomeRow[],
): Record<string, VariantWinRate> {
  // Object.create(null) — a null-prototype map so a malicious/odd variantId like
  // "__proto__" / "constructor" becomes a plain OWN key instead of a write to
  // Object.prototype (prototype-pollution defense — MONEY-779 security scan).
  const acc: Record<string, { wins: number; impressions: number }> =
    Object.create(null);
  for (const row of rows) {
    const id = row?.variantId;
    if (!id) continue;
    const bucket = (acc[id] ??= { wins: 0, impressions: 0 });
    bucket.impressions += 1;
    if (row.outcome === "UP") bucket.wins += 1;
  }
  const out: Record<string, VariantWinRate> = Object.create(null);
  for (const [id, { wins, impressions }] of Object.entries(acc)) {
    out[id] = {
      wins,
      impressions,
      winRate: impressions > 0 ? wins / impressions : 0,
    };
  }
  return out;
}

/** Options for {@link selectVariant}. */
export interface SelectVariantOptions {
  /**
   * Injected RNG. When supplied, selection is stochastic (epsilon-greedy by
   * default — see `strategy`). When OMITTED, selection is the deterministic
   * argmax of the posterior mean (so tests without an rng are stable).
   */
  rng?: Rng;
  /**
   * Exploration policy when an `rng` is supplied:
   *   - "epsilon-greedy" (default): with prob ε explore a uniformly-random arm,
   *     else exploit the highest posterior mean.
   *   - "thompson": sample a reward from each arm's Beta posterior, pick the max.
   */
  strategy?: "epsilon-greedy" | "thompson";
  /** Exploration rate for epsilon-greedy. Default 0.1. */
  epsilon?: number;
}

/**
 * Choose a variant given each variant's Beta prior.
 *
 * - WITHOUT an `rng` (the default): deterministic — pick the arm with the
 *   highest posterior {@link betaMean}. Ties resolve to the first variant in
 *   list order, so the result is stable and reproducible.
 * - WITH an `rng`: epsilon-greedy by default (explore a random arm with prob ε,
 *   else exploit the best mean), or Thompson sampling when `strategy:"thompson"`.
 *   Tests inject a fixed `rng` to make either path deterministic.
 *
 * `priorsById` need not cover every variant — any variant without an entry uses
 * an uninformative Beta(1,1) (mean 0.5), so it stays explorable. Returns the
 * chosen variant's `id`. Falls back to {@link DEFAULT_VARIANT_ID} (or the first
 * variant) when `variants` is empty-ish.
 */
export function selectVariant(
  variants: readonly Variant[],
  priorsById: Record<string, BetaArm>,
  options: SelectVariantOptions = {},
): string {
  if (!variants || variants.length === 0) return DEFAULT_VARIANT_ID;

  const armOf = (v: Variant): BetaArm =>
    priorsById[v.id] ?? { alpha: 1, beta: 1 };

  // Deterministic exploit when no rng is injected: highest posterior mean,
  // first-in-list wins ties.
  if (!options.rng) {
    let best = variants[0]!;
    let bestScore = betaMean(armOf(best));
    for (const v of variants.slice(1)) {
      const score = betaMean(armOf(v));
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best.id;
  }

  const rng = options.rng;
  const strategy = options.strategy ?? "epsilon-greedy";

  if (strategy === "thompson") {
    let best = variants[0]!;
    let bestScore = sampleBeta(armOf(best), rng);
    for (const v of variants.slice(1)) {
      const score = sampleBeta(armOf(v), rng);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best.id;
  }

  // epsilon-greedy
  const epsilon = clamp01(options.epsilon ?? 0.1);
  if (rng() < epsilon) {
    // EXPLORE — uniformly random arm.
    const idx = Math.min(
      variants.length - 1,
      Math.floor(rng() * variants.length),
    );
    return variants[idx]!.id;
  }
  // EXPLOIT — highest posterior mean (first-in-list wins ties).
  let best = variants[0]!;
  let bestScore = betaMean(armOf(best));
  for (const v of variants.slice(1)) {
    const score = betaMean(armOf(v));
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best.id;
}

/**
 * Build the `priorsById` map {@link selectVariant} consumes directly from
 * per-variant win-rates (the output of {@link computeVariantWinRates}). A thin
 * convenience that folds each variant's (wins, impressions) into an informed
 * Beta arm via {@link armFromWinRate}.
 */
export function priorsFromWinRates(
  winRates: Record<string, VariantWinRate>,
): Record<string, BetaArm> {
  const out: Record<string, BetaArm> = {};
  for (const [id, wr] of Object.entries(winRates)) {
    out[id] = armFromWinRate(wr.wins, wr.impressions);
  }
  return out;
}
