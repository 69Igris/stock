/**
 * Detect corporate actions from the price series itself — MONEY-1176.
 *
 * ## Why the exchange feeds are not enough
 *
 * NSE's corporate-actions API stops serving history around 2020 (measured
 * during the backfill: the NSE leg plateaus at 5,634 rows while BSE keeps
 * climbing), and BSE's own coverage thins further back. But `DailyPrice` now
 * holds clean raw exchange prices to 1994-11-03 (MONEY-1175), and a split
 * leaves an unmistakable fingerprint in them.
 *
 * ## Why this is reliable now, and would NOT have been before
 *
 * The series is uniformly RAW. Before MONEY-1175 it was a mixture of raw
 * bhavcopy and split-ADJUSTED Yahoo, so a ratio jump could equally be a real
 * split or an artefact of the source flipping. With one basis, a clean jump is
 * a real event.
 *
 * ## What separates a split from a crash
 *
 * A split moves the price by an EXACT rational — 1/2, 1/5, 1/10 — because that
 * is arithmetic, not sentiment. A crash lands on an arbitrary number. So a
 * candidate is only accepted when the observed ratio snaps to a plausible
 * corporate ratio within a small tolerance; anything else is left alone as
 * ordinary trading. Real examples this must catch, measured on prod:
 *
 *     INFY 2014-12-02 x0.489 · SBIN 2014-11-20 x0.102
 *     YESBANK 2017-09-21 x0.201 · GOLDBEES 2019-12-19 x0.010
 *
 * ## What it deliberately does NOT do
 *
 * It does not guess the TYPE. A factor of exactly 2 is equally a 1:1 bonus or
 * a 2:1 split, and the two are different corporate events with different tax
 * treatment. Claiming one would be inventing a fact, so a price-derived row is
 * written as `CAPITAL_ADJUSTMENT` and carries `observedRatio` — enough to
 * ADJUST a chart correctly, without asserting something unverified. When a
 * real feed row exists for the same event, the reconciler prefers it.
 */

/** One day of the raw exchange series. */
export interface DetectBar {
  date: Date;
  close: number;
  volume: number;
}

export interface ActionCandidate {
  /** The first day trading at the NEW price — the ex-date. */
  exDate: Date;
  /** close(prev) / close(exDate) — the post:pre share factor. */
  observedRatio: number;
  /** The exact rational it snapped to. */
  snappedRatio: number;
  /** Raw closes either side, for the audit trail. */
  prevClose: number;
  exClose: number;
  /** How strongly volume corroborates it. */
  confidence: "high" | "medium" | "low";
  volumeRatio: number | null;
}

/**
 * Ratios a corporate action actually produces.
 *
 * Splits and bonuses in India are quoted in small whole numbers, so the set of
 * possible factors is short and known. Anything outside it is not arithmetic.
 */
export const PLAUSIBLE_RATIOS: readonly number[] = [
  1.5, // 1:2 bonus (3 for 2)
  2, // 1:1 bonus / 2:1 split
  2.5,
  3, // 2:1 bonus / 3:1 split
  4,
  5, // 1:5 split
  6,
  10, // 1:10 split
  20,
  50,
  100, // 1:100 split
  // Reverse splits / consolidations.
  0.5,
  0.2,
  0.1,
];

/** Relative distance within which an observed ratio counts as "that" ratio. */
export const SNAP_TOLERANCE = 0.03;

/** Minimum single-day move worth examining at all. */
export const MIN_JUMP = 0.25;

/**
 * Minimum pre-event price for a ratio to mean anything.
 *
 * Below this the inference collapses, and the first full production run proved
 * it: 205 of 361 derived rows landed under Rs 20, 55 of them under Rs 1, and
 * 21STCENMGM alone produced SEVEN "splits" in three years at prices between
 * Rs 0.05 and Rs 4.65 — 0.30 -> 0.15, 0.15 -> 0.10, 0.10 -> 0.05.
 *
 * Two effects combine at penny prices. Ticks are coarse relative to the price,
 * so 0.30 and 0.15 are 6 and 3 ticks and their ratio is EXACTLY 2 by
 * arithmetic accident rather than by corporate action. And a 50% single-day
 * move is ordinary volatility for a penny stock, where at Rs 1,000 it is
 * essentially always structural. The rational-snap test cannot separate those,
 * so the only honest move is to decline the whole price region.
 */
export const MIN_PRICE = 20;

/**
 * Most corporate actions one instrument may yield before the SERIES is judged
 * untrustworthy rather than eventful.
 *
 * A real company splits a handful of times in thirty years. The first run gave
 * ANTGRAPHIC 28 and BLUECHIP 15 — not companies with 28 splits, but series
 * whose price behaviour defeats the detector. Discarding all of an
 * instrument's candidates is right: if the series produces nonsense at that
 * rate, the individual candidates cannot be trusted either.
 */
export const MAX_ACTIONS_PER_INSTRUMENT = 6;

/**
 * Longest calendar gap between the two closes a cliff may be read across —
 * MONEY-1600.
 *
 * The scan compares adjacent BARS, and adjacent bars are not always adjacent
 * sessions. SAYAJIHOTL:NSE traded to 2015-01-16 and next printed on 2026-04-22,
 * after eleven years off the exchange; 138.70 -> 276.00 snapped to 0.5 and the
 * detector wrote a reverse split that never happened. Over a gap that long
 * ordinary drift lands within 3% of SOME plausible ratio often enough that the
 * snap test stops meaning anything.
 *
 * Measured over all 156 prod DERIVED rows on 2026-09-23, the previous close
 * sits within 4 days for 140, 5-7 for 6, 8-14 for 5, 15-31 for 3 — then 132
 * days (KANORICHEM:NSE 1996, 69.45 -> 35.00 and back to 60 within three weeks)
 * and 4,114 (SAYAJIHOTL). The longest gap a FEED corroborates is VEGA:BSE's 12
 * days around its BONUS 5, a trading halt across the record date. A month
 * keeps every row up to 29 days and refuses the two outliers.
 */
export const MAX_CLIFF_GAP_DAYS = 31;

const DAY_MS = 86_400_000;

/** Calendar days from one bar to the next. */
function gapDays(before: DetectBar, onDay: DetectBar): number {
  return (onDay.date.getTime() - before.date.getTime()) / DAY_MS;
}

/** Nearest plausible ratio, or null when the move is not arithmetic. */
export function snapRatio(observed: number): number | null {
  if (!Number.isFinite(observed) || observed <= 0) return null;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const r of PLAUSIBLE_RATIOS) {
    const err = Math.abs(observed - r) / r;
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return bestErr <= SNAP_TOLERANCE ? best : null;
}

/**
 * Volume corroboration.
 *
 * After a 1:10 split the same rupee turnover is ~10x the share count, so
 * volume should rise by roughly the factor. This is a SCORE, never a gate:
 * illiquid names have noisy volume and rejecting on it would lose real splits.
 */
function scoreVolume(
  volumeRatio: number | null,
  factor: number,
): ActionCandidate["confidence"] {
  if (volumeRatio === null || !Number.isFinite(volumeRatio) || volumeRatio <= 0)
    return "low";
  // Compared in LOG space so the score is symmetric. A relative error of
  // |v - f| / f cannot exceed 1 when volume FALLS, so "low" would be
  // unreachable for the most damning case of all — volume dropping after a
  // 1:10 split — and non-corroboration would score the same as a mild miss.
  const err = Math.abs(Math.log(volumeRatio / factor));
  if (err <= 0.5) return "high"; // within ~1.65x either way
  if (err <= 1.5) return "medium"; // within ~4.5x
  return "low";
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Scan one instrument's raw series for corporate actions.
 *
 * `bars` must be sorted ascending and come from EXCHANGE sources only — Yahoo
 * rows are split-adjusted and would show no jump at all, hiding the very
 * events this looks for.
 */
export function detectActions(
  bars: readonly DetectBar[],
  options: {
    minJump?: number;
    minPrice?: number;
    maxActions?: number;
    maxGapDays?: number;
  } = {},
): ActionCandidate[] {
  const minJump = options.minJump ?? MIN_JUMP;
  const minPrice = options.minPrice ?? MIN_PRICE;
  const maxActions = options.maxActions ?? MAX_ACTIONS_PER_INSTRUMENT;
  const maxGapDays = options.maxGapDays ?? MAX_CLIFF_GAP_DAYS;
  const out: ActionCandidate[] = [];
  // Every clean-ratio move, gap or no gap — what the COUNT guard judges.
  let moves = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    // See MIN_PRICE: below this a clean ratio is tick arithmetic, not an event.
    if (prev.close < minPrice) continue;

    const move = cur.close / prev.close - 1;
    if (Math.abs(move) < minJump) continue;

    // A split DIVIDES the price, so the post:pre share factor is the INVERSE
    // of the price move.
    const observedRatio = prev.close / cur.close;
    const snapped = snapRatio(observedRatio);
    if (snapped === null) continue;
    moves++;
    // See MAX_CLIFF_GAP_DAYS: across a long gap the move is drift, not a day.
    // Skipped AFTER it is counted, so the gap rule can never turn a series the
    // count guard refuses into one it accepts.
    if (gapDays(prev, cur) > maxGapDays) continue;

    const before = mean(bars.slice(Math.max(0, i - 5), i).map((b) => b.volume));
    const after = mean(bars.slice(i, i + 5).map((b) => b.volume));
    const volumeRatio =
      before !== null && after !== null && before > 0 ? after / before : null;

    out.push({
      exDate: cur.date,
      observedRatio,
      snappedRatio: snapped,
      prevClose: prev.close,
      exClose: cur.close,
      confidence: scoreVolume(volumeRatio, snapped),
      volumeRatio,
    });
  }

  // An implausible COUNT invalidates the whole series, not just the excess:
  // whatever makes a series yield 28 candidates makes each one unreliable.
  if (moves > maxActions) return [];

  return out;
}

/**
 * What a listing's OWN series says today about a cliff a DERIVED row claims.
 *
 *   CONFIRMED      the close on its day and the one before it, within
 *                  `MAX_CLIFF_GAP_DAYS`, divide to the row's ratio within
 *                  `SNAP_TOLERANCE` — the detector would write it again
 *   REFUTED        both closes are there and within reach, and their move is
 *                  not the row's ratio: the cliff has left the series
 *   GAP            the close on its day is there, and the close before it is
 *                  more than `MAX_CLIFF_GAP_DAYS` back: there is no one-day
 *                  move to witness, only drift across a trading gap
 *   NO_BAR_BEFORE  the close on its day is there and NO close precedes it —
 *                  a truncated series, or history held under another
 *                  instrument. Absence of evidence, never a gap
 *   NO_BAR_ON_DAY  the series holds no close on the row's day, so it cannot
 *                  speak to the row either way — the series moved, was lost,
 *                  or never covered that session
 *
 * REFUTED and GAP are the detector's own test failing on the current series;
 * the two NO_BAR verdicts are the absence of a test. Only the first two may
 * retire a row.
 */
export type CliffVerdict =
  | "CONFIRMED"
  | "REFUTED"
  | "GAP"
  | "NO_BAR_BEFORE"
  | "NO_BAR_ON_DAY";

export function verifyCliff(
  evidence: { onDay: DetectBar | null; before: DetectBar | null },
  ratio: number,
  maxGapDays: number = MAX_CLIFF_GAP_DAYS,
): {
  verdict: CliffVerdict;
  observedRatio: number | null;
  gapDays: number | null;
} {
  const { onDay, before } = evidence;
  if (!onDay || !(onDay.close > 0)) {
    return { verdict: "NO_BAR_ON_DAY", observedRatio: null, gapDays: null };
  }
  if (!before || !(before.close > 0)) {
    return { verdict: "NO_BAR_BEFORE", observedRatio: null, gapDays: null };
  }
  const gap = gapDays(before, onDay);
  const observedRatio = before.close / onDay.close;
  if (gap > maxGapDays) return { verdict: "GAP", observedRatio, gapDays: gap };
  const within = Math.abs(observedRatio - ratio) / ratio <= SNAP_TOLERANCE;
  return {
    verdict: within ? "CONFIRMED" : "REFUTED",
    observedRatio,
    gapDays: gap,
  };
}

/** An existing feed-sourced action, for reconciliation. */
export interface KnownAction {
  type: string;
  exDate: Date;
}

/** Candidates within this many days of a known action are already covered. */
export const RECONCILE_DAYS = 3;

/**
 * Drop candidates a real feed already explains.
 *
 * A feed row carries the actual TYPE and ratio; a derived row only knows the
 * factor. Where both describe the same event the feed wins, so this keeps only
 * what the feeds missed.
 */
export function reconcileCandidates(
  candidates: readonly ActionCandidate[],
  known: readonly KnownAction[],
): { fresh: ActionCandidate[]; alreadyKnown: number } {
  const days = RECONCILE_DAYS * 86_400_000;
  const times = known.map((k) => k.exDate.getTime());
  const fresh: ActionCandidate[] = [];
  let alreadyKnown = 0;

  for (const c of candidates) {
    const t = c.exDate.getTime();
    if (times.some((k) => Math.abs(k - t) <= days)) {
      alreadyKnown++;
      continue;
    }
    fresh.push(c);
  }
  return { fresh, alreadyKnown };
}
