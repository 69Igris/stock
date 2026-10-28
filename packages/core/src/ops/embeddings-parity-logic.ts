/**
 * Judging v1-vs-v2 retrieval parity. MONEY-1499 (B8).
 *
 * PURE. `scripts/ops/embeddings-parity.ts` is the I/O shell.
 *
 * B0 §6 sets two of B8's five acceptance criteria here:
 *
 *   Parity   50 sampled research queries, top-K before and after, overlap
 *            >= 0.9, "A query set fixed BEFORE the migration, so it cannot be
 *            chosen to pass."
 *   Latency  `fetch-document-context` p95 no worse than the pre-migration
 *            measurement, "taken over the same window length".
 *
 * The verdict lives here rather than in the script for one reason: a threshold
 * inside a reporting loop is a threshold somebody edits while staring at a
 * number they want to pass.
 */

/** B0 §6. Applied to the MEAN across the fixed query set. */
export const PARITY_MIN_OVERLAP = 0.9;

/**
 * The PER-QUERY floor, expressed as "how many of the top-K may differ" rather
 * than as a ratio — MONEY-1499 review.
 *
 * `overlapAt` returns `hit / k`, so at the shipped `topK: 6` the only
 * achievable values are {0, .167, .333, .5, .667, .833, 1}. Comparing those
 * against 0.9 makes 1.0 the ONLY passing value: the per-query rung silently
 * became "every one of the fifty queries must return a byte-identical top-6".
 *
 * Which is precisely the thing `overlapAt`'s own docblock says will not
 * happen — "int8 perturbs scores slightly, so ranks within a result set
 * shuffle by a place or two on near-ties" — and the two indexes are ANN graphs
 * queried at numCandidates 72 over ~5.9M rows, so a document crossing the
 * rank-6 boundary on one query of fifty is the EXPECTED outcome, not a
 * regression. A gate whose only exits are abandoning a correct migration or
 * editing the constant while staring at the number is the failure this module
 * header says the constant was extracted here to prevent.
 *
 * ONE. A single displaced document is rank noise; two out of six is a
 * different answer to the question.
 */
export const PARITY_MAX_MISSING_PER_QUERY = 1;

/** The per-query floor on the grid `overlapAt` can actually produce. */
export function perQueryFloor(k: number): number {
  if (k <= 0) return 0;
  return Math.max(0, k - PARITY_MAX_MISSING_PER_QUERY) / k;
}

/**
 * How much slower v2's p95 may be before it counts as a regression.
 *
 * NOT 1.0. The two measurements are taken minutes apart against a live
 * cluster, so a strict comparison fails on ordinary variance and teaches
 * everyone to re-run until it passes — which is worse than a stated tolerance,
 * because the tolerance then exists and is undocumented. 10% is the band; a
 * real regression from fetching a 6x smaller vector would be far larger, and
 * the expected direction is FASTER.
 */
export const LATENCY_TOLERANCE = 1.1;

export interface QueryResult {
  readonly query: string;
  /** Result ids in rank order, best first. */
  readonly v1: readonly string[];
  readonly v2: readonly string[];
  readonly v1Ms: number;
  readonly v2Ms: number;
}

/**
 * Jaccard-free SET overlap at K: |A ∩ B| / K, on the top K of each side.
 *
 * Deliberately NOT rank correlation. int8 perturbs scores slightly, so ranks
 * within a result set shuffle by a place or two on near-ties; what matters for
 * a RAG context window is whether the same DOCUMENTS come back.
 *
 * The denominator is K, not |A|, so a v2 that returns FEWER results is
 * penalised. Dividing by the smaller set would let a v2 returning one row that
 * v1 also had score 1.0 — a perfect parity report for a collapsed index.
 */
export function overlapAt(
  k: number,
  a: readonly string[],
  b: readonly string[],
): number {
  if (k <= 0) return 0;
  const top = new Set(a.slice(0, k));
  let hit = 0;
  for (const id of b.slice(0, k)) if (top.has(id)) hit++;
  return hit / k;
}

/** Nearest-rank percentile. `p` in 0..1. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}

export interface ParityVerdict {
  readonly pass: boolean;
  readonly meanOverlap: number;
  readonly worstOverlap: number;
  readonly belowThreshold: readonly string[];
  readonly p95V1: number;
  readonly p95V2: number;
  readonly latencyRatio: number;
  readonly reasons: readonly string[];
}

/**
 * The gate. Refuses on an EMPTY result set rather than passing it — two
 * averages compared with `>=` make a population of zero read OK for ever,
 * which is the not-measured-is-not-passed defect this repo has shipped at
 * several layers.
 */
export function judgeParity(
  results: readonly QueryResult[],
  opts: { k: number; minQueries: number },
): ParityVerdict {
  const reasons: string[] = [];
  if (results.length < opts.minQueries) {
    reasons.push(
      `only ${results.length} of ${opts.minQueries} queries produced a comparison — ` +
        "too few to judge, and an empty set must never read as a pass",
    );
  }

  const overlaps = results.map((r) => overlapAt(opts.k, r.v1, r.v2));
  const meanOverlap =
    overlaps.length > 0
      ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length
      : 0;
  const worstOverlap = overlaps.length > 0 ? Math.min(...overlaps) : 0;
  const floor = perQueryFloor(opts.k);
  const belowThreshold = results
    .filter((_, i) => overlaps[i]! < floor)
    .map((r) => r.query);

  if (meanOverlap < PARITY_MIN_OVERLAP) {
    reasons.push(
      `mean top-${opts.k} overlap ${meanOverlap.toFixed(3)} is below ${PARITY_MIN_OVERLAP}`,
    );
  }

  // A MEAN HIDES A TAIL — MONEY-1499 review, F4.
  //
  // 45 queries at 1.0 and 5 at 0.0 means 0.900, which cleared this gate while
  // five research queries returned an ENTIRELY DIFFERENT document set from v1.
  // `belowThreshold` was computed and printed and did not enter the verdict.
  //
  // B0 §6 says "top-K before and after, overlap >= 0.9" and is ambiguous
  // between the mean and the per-query floor. This resolves it by gating BOTH,
  // because the thing being gated is whether a user gets a worse chat turn, and
  // a tail of bad answers is exactly what an average is built to conceal.
  //
  // The two rungs read DIFFERENT thresholds on purpose: 0.9 is not expressible
  // on a 6-point grid, so the per-query rung is stated in documents rather than
  // in a ratio (`PARITY_MAX_MISSING_PER_QUERY`). Reusing 0.9 here demanded a
  // byte-identical top-6 on every query — see that constant's docblock.
  if (belowThreshold.length > 0) {
    reasons.push(
      `${belowThreshold.length} of ${results.length} queries lost more than ` +
        `${PARITY_MAX_MISSING_PER_QUERY} of the top-${opts.k} ` +
        `(floor ${floor.toFixed(3)}, worst ${worstOverlap.toFixed(3)}): ` +
        `${belowThreshold.slice(0, 5).join(" | ")}` +
        `${belowThreshold.length > 5 ? " …" : ""}`,
    );
  }

  const p95V1 = percentile(
    results.map((r) => r.v1Ms),
    0.95,
  );
  const p95V2 = percentile(
    results.map((r) => r.v2Ms),
    0.95,
  );
  const latencyRatio = p95V1 > 0 ? p95V2 / p95V1 : Number.NaN;
  if (!Number.isFinite(latencyRatio)) {
    reasons.push(
      "latency could not be compared — v1 p95 is zero or unmeasured",
    );
  } else if (latencyRatio > LATENCY_TOLERANCE) {
    reasons.push(
      `v2 p95 ${p95V2.toFixed(0)}ms is ${latencyRatio.toFixed(2)}x v1's ${p95V1.toFixed(0)}ms ` +
        `(tolerance ${LATENCY_TOLERANCE}x) — this path runs inside a chat turn`,
    );
  }

  return {
    pass: reasons.length === 0,
    meanOverlap,
    worstOverlap,
    belowThreshold,
    p95V1,
    p95V2,
    latencyRatio,
    reasons,
  };
}
