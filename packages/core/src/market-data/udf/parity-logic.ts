/**
 * UDF parity — the comparison rules. MONEY-1468 (data-platform A3).
 *
 * Diffs a bar series served by the LIVE web route (Yahoo) against the same
 * series from `apps/market-data` (tiles), so the chart can be flipped on
 * evidence rather than on hope.
 *
 * ## YAHOO IS THE BASELINE, NOT THE AUTHORITY
 *
 * This is the trap in this comparison and it is worth stating before any
 * threshold. Yahoo is what the chart shows TODAY, which is the only reason it
 * is the thing to compare against. It is NOT the more correct source: on a
 * CLOSED Indian session the exchange's own bhavcopy wins, by the declared
 * precedence `BHAVCOPY 100 > TIINGO 60 > … > YAHOO 10` that
 * `mayWritePriceSource` already enforces (MONEY-1175).
 *
 * So a disagreement has THREE outcomes here, not two:
 *
 *   MATCH      within tolerance
 *   EXPLAINED  a known, documented divergence where the tile is the better
 *              number — recorded, and NOT a failure
 *   FAILURE    everything else, fixed at the SOURCE
 *
 * A parity run that "fixed" tiles to match Yahoo would be regressing to the
 * weaker source while reporting success, which is the most expensive possible
 * outcome of this exercise.
 *
 * ## THE TOLERANCE IS NEVER THE FIX
 *
 * Every FAILURE is a wrong adjustment, a missing year tile or a timezone split.
 * Widening a threshold converts a real defect into a green report and is the
 * one change this module must never absorb — which is why the thresholds are
 * exported constants pinned by a test rather than parameters.
 */

/** OHLC must agree within 0.5% OR 0.05 absolute — Yahoo rounds. */
export const PRICE_TOLERANCE_PCT = 0.005;
export const PRICE_TOLERANCE_ABS = 0.05;

/**
 * India volume may differ by 2% and is REPORTED, never failed.
 *
 * bhavcopy and Yahoo genuinely disagree on some sessions' volume — different
 * venues counted, different treatment of blocks. The price is the number a
 * chart is read for; the volume bar is context.
 */
export const VOLUME_TOLERANCE_PCT = 0.02;

export type BarField = "o" | "h" | "l" | "c" | "v";

export interface UdfSeries {
  s: string;
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  nextTime?: number;
}

export type DiffVerdict = "match" | "explained" | "failure";

export interface BarDiff {
  t: number;
  field: BarField;
  baseline: number;
  candidate: number;
  deltaPct: number;
  verdict: DiffVerdict;
  /** Why an `explained` diff is acceptable. Required when explained. */
  reason?: string;
}

export interface ParityResult {
  listing: string;
  range: string;
  /** Both answered the same SHAPE (ok/no_data/error). */
  shapeAgrees: boolean;
  baselineShape: string;
  candidateShape: string;
  /** Bar counts, which must be exact when both are `ok`. */
  baselineCount: number;
  candidateCount: number;
  /** Timestamps present in one series and not the other. */
  missingFromCandidate: number[];
  extraInCandidate: number[];
  diffs: BarDiff[];
  verdict: DiffVerdict;
  notes: string[];
}

/** Relative difference, guarding a zero baseline. */
export function relDelta(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : 1;
  return Math.abs(candidate - baseline) / Math.abs(baseline);
}

/** Is an OHLC pair within tolerance? EITHER bound satisfies it. */
export function priceWithinTolerance(
  baseline: number,
  candidate: number,
): boolean {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return false;
  if (Math.abs(candidate - baseline) <= PRICE_TOLERANCE_ABS) return true;
  return relDelta(baseline, candidate) <= PRICE_TOLERANCE_PCT;
}

/**
 * Classify a VOLUME difference.
 *
 * The known-acceptable class, documented rather than fixed: Yahoo serves
 * BACK-ADJUSTED volume across some splits, while a tile keeps raw volume scaled
 * by the split factor — `applyAdjustment` multiplies volume by the cumulative
 * factor, the OPPOSITE direction to price, deliberately, because the same
 * turnover is spread over R times as many shares. A ratio close to a small
 * integer or its reciprocal is that, not a data error.
 */
export function classifyVolumeDiff(
  baseline: number,
  candidate: number,
  opts: { market: "IN" | "US"; hadSplit: boolean },
): { verdict: DiffVerdict; reason?: string } {
  if (relDelta(baseline, candidate) <= VOLUME_TOLERANCE_PCT)
    return { verdict: "match" };

  if (opts.hadSplit && baseline > 0 && candidate > 0) {
    const ratio = candidate / baseline;
    for (const f of [2, 3, 4, 5, 10, 20]) {
      if (
        Math.abs(ratio - f) / f <= 0.02 ||
        Math.abs(ratio - 1 / f) * f <= 0.02
      ) {
        return {
          verdict: "explained",
          reason:
            `volume ratio ~${ratio.toFixed(3)} across a split — Yahoo back-adjusts volume, ` +
            "tiles scale raw volume by the split factor (documented divergence)",
        };
      }
    }
  }

  // India volume is REPORTED, never failed: bhavcopy and Yahoo count different
  // venues on some sessions, and the price is the number a chart is read for.
  if (opts.market === "IN") {
    return {
      verdict: "explained",
      reason: `India volume differs ${(relDelta(baseline, candidate) * 100).toFixed(2)}% — bhavcopy vs Yahoo; reported, not failed`,
    };
  }
  return { verdict: "failure" };
}

/** The worst verdict present. `failure` > `explained` > `match`. */
export function worstVerdict(verdicts: readonly DiffVerdict[]): DiffVerdict {
  if (verdicts.includes("failure")) return "failure";
  if (verdicts.includes("explained")) return "explained";
  return "match";
}

/**
 * Compare one range for one listing.
 *
 * `hadSplit` is supplied by the caller (it knows the corporate actions), not
 * inferred from the numbers — inferring "this looks like a split" from the very
 * discrepancy under test is how a real error gets explained away.
 */
export function compareSeries(
  listing: string,
  range: string,
  baseline: UdfSeries,
  candidate: UdfSeries,
  opts: { market: "IN" | "US"; hadSplit: boolean },
): ParityResult {
  const notes: string[] = [];
  const result: ParityResult = {
    listing,
    range,
    shapeAgrees: baseline.s === candidate.s,
    baselineShape: baseline.s,
    candidateShape: candidate.s,
    baselineCount: baseline.t?.length ?? 0,
    candidateCount: candidate.t?.length ?? 0,
    missingFromCandidate: [],
    extraInCandidate: [],
    diffs: [],
    verdict: "match",
    notes,
  };

  if (baseline.s !== candidate.s) {
    // `no_data` against `ok` is the most important disagreement in this whole
    // exercise: it is a chart that is blank on one path and populated on the
    // other, and it renders as an empty chart rather than an error.
    result.verdict = "failure";
    notes.push(
      `shape mismatch: baseline=${baseline.s} candidate=${candidate.s}`,
    );
    return result;
  }

  if (baseline.s === "no_data") {
    // `nextTime` must agree EXACTLY: it is what stops the widget looping
    // backwards forever, so a difference here is an infinite spinner on one
    // path and not the other.
    if (baseline.nextTime !== candidate.nextTime) {
      result.verdict = "failure";
      notes.push(
        `nextTime mismatch: baseline=${String(baseline.nextTime)} candidate=${String(candidate.nextTime)}`,
      );
    }
    return result;
  }

  // NEITHER SIDE ANSWERED. Shapes "agree" and it is not `no_data`, so the
  // initialised `match` used to survive — and that is the most dangerous
  // possible verdict here. Concrete: an EXPIRED Clerk token 401s every
  // baseline, the candidate is mid-deploy, and the run reports
  // `matched = total, failed = 0, PASS = yes` over comparisons that measured
  // nothing. `main()` guards a MISSING token and cannot see an expired one.
  //
  // An error pair is a REFUSAL, the same way an empty run is not a pass.
  if (baseline.s === "error") {
    result.verdict = "failure";
    notes.push(
      'both sides answered s:"error" — nothing was compared. An expired ' +
        "UDF_PARITY_CLERK_TOKEN, an unsupported symbol or a service mid-deploy " +
        "all look like this, and none of them is parity.",
    );
    return result;
  }
  if (baseline.s !== "ok") return result;

  const bT = baseline.t ?? [];
  const cT = candidate.t ?? [];
  const cIndex = new Map(cT.map((t, i) => [t, i]));
  const bSet = new Set(bT);

  result.missingFromCandidate = bT.filter((t) => !cIndex.has(t));
  result.extraInCandidate = cT.filter((t) => !bSet.has(t));

  const verdicts: DiffVerdict[] = [];
  if (result.missingFromCandidate.length || result.extraInCandidate.length) {
    verdicts.push("failure");
    notes.push(
      `bar set differs: ${result.missingFromCandidate.length} missing, ${result.extraInCandidate.length} extra`,
    );
  }

  for (let i = 0; i < bT.length; i++) {
    const t = bT[i]!;
    const j = cIndex.get(t);
    if (j === undefined) continue;

    for (const field of ["o", "h", "l", "c"] as const) {
      const b = baseline[field]?.[i];
      const c = candidate[field]?.[j];
      if (b === undefined || c === undefined) continue;
      if (priceWithinTolerance(b, c)) continue;
      const d: BarDiff = {
        t,
        field,
        baseline: b,
        candidate: c,
        deltaPct: relDelta(b, c),
        verdict: "failure",
      };
      result.diffs.push(d);
      verdicts.push("failure");
    }

    const bv = baseline.v?.[i];
    const cv = candidate.v?.[j];
    if (bv !== undefined && cv !== undefined) {
      const { verdict, reason } = classifyVolumeDiff(bv, cv, opts);
      if (verdict !== "match") {
        result.diffs.push({
          t,
          field: "v",
          baseline: bv,
          candidate: cv,
          deltaPct: relDelta(bv, cv),
          verdict,
          ...(reason ? { reason } : {}),
        });
        verdicts.push(verdict);
      }
    }
  }

  result.verdict = worstVerdict(verdicts);
  return result;
}

/** Roll a run up. FAILURES are what gate the flip; explained diffs are not. */
export function summarise(results: readonly ParityResult[]): {
  total: number;
  matched: number;
  explained: number;
  failed: number;
  pass: boolean;
} {
  const matched = results.filter((r) => r.verdict === "match").length;
  const explained = results.filter((r) => r.verdict === "explained").length;
  const failed = results.filter((r) => r.verdict === "failure").length;
  return {
    total: results.length,
    matched,
    explained,
    failed,
    // An EMPTY run is not a pass. Two counts compared with `===` make a run
    // that compared nothing read as perfect parity, which is the
    // not-measured-is-not-passed defect this repo keeps paying for.
    pass: results.length > 0 && failed === 0,
  };
}
