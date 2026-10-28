/**
 * Roast SERVICE pure-logic helpers (MONEY-620).
 *
 * The roast SERVICE (`./roast.service.ts`) is the CRUD/status surface the web
 * action (`apps/web/lib/actions/roast.ts`) and chat reconcile path call. It used
 * to forward the raw Prisma `score` / `progress` columns straight to the UI with
 * NO sanitation:
 *
 *   - `getRoastStatus` → `{ score, progress, … }` rendered verbatim by the
 *     score gauge (`{score}`) and the progress view (`{progress}%`).
 *   - `getRunningRoasts` / `getRecentRoastSessions` / `getRoastHistory` →
 *     list rows whose `score` / `progress` the chat & history UIs render raw.
 *
 * A corrupt write from the worker pipeline (a `NaN` score that coerced from a
 * non-numeric model output, an out-of-range `progress` from a buggy step
 * counter, a `progress` that overshoots 100) therefore reached the consumer as
 * `NaN`, `NaN%`, `Infinity%`, `150%`, or a gauge whose colour/label band the
 * out-of-range value escaped. None of this is caught by `yarn build` (types are
 * fine) — it only surfaces at render time, exactly the "happy-path fixtures"
 * blind spot the test-writing policy calls out.
 *
 * These functions are extracted as PURE, exported symbols so:
 *   - the SERVICE calls them on the Prisma-returned rows (the SAME code path as
 *     production), and
 *   - tests import & assert the REAL implementation (no shadow copy).
 *
 * No DB / network / AI dependency — safe to import from any test runner.
 *
 * `finite()` mirrors `./dashboard-logic.ts#finite` and `./holdings-logic.ts#finite`
 * (kept LOCAL on purpose so this module has zero cross-logic coupling). The
 * score-clamp policy (`null`/`NaN`/out-of-range → neutral default, round to int,
 * bound to [0,100]) mirrors `packages/roast/src/lib/score-utils.ts#clampScore`,
 * which shapes the FINAL `overallScore` in the heavy roast pipeline — the
 * service applies the SAME contract to the status/score column it surfaces.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (LOCAL — see header)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Score clamps
// ---------------------------------------------------------------------------

/** The neutral default a missing/garbage score degrades to (matches score-utils). */
export const DEFAULT_ROAST_SCORE = 50;

/**
 * Clamp a raw NON-NULLABLE score (the assembled `overallScore`) into the
 * inclusive 0–100 integer band the gauge renders.
 *
 *   - `undefined`/`null` → {@link DEFAULT_ROAST_SCORE} (50). A missing field
 *     degrades to "neutral" rather than poisoning the gauge.
 *   - `NaN`/`±Infinity` → 50. Without this `Math.round(NaN)` stays `NaN` and a
 *     `NaN` reaches the gauge / the DB `score` column.
 *   - fractional → rounded to nearest int; out-of-[0,100] → clamped to bound.
 *
 * Returns a finite integer in [0, 100], always. Mirrors
 * `packages/roast/src/lib/score-utils.ts#clampScore` (uses `?? 50`, NOT
 * `|| 50`, so a legitimate score of `0` is preserved, not bumped to 50).
 */
export function clampScore(v: number | undefined | null): number {
  const n = v ?? DEFAULT_ROAST_SCORE;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_ROAST_SCORE;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Clamp a NULLABLE score column (`PortfolioRoast.score`) for the status / list
 * surfaces, where `null` is SEMANTICALLY MEANINGFUL — it means "not scored
 * yet" (the roast is still running). So:
 *
 *   - `null`/`undefined` → `null` (PRESERVED — do NOT default to 50; an
 *     in-progress roast must not show a phantom score of 50).
 *   - a PRESENT but non-finite (`NaN`/`±Infinity`) score → 50 (a real score was
 *     attempted but corrupted; 50 is the neutral fallback, never `NaN`).
 *   - a present out-of-[0,100] / fractional score → rounded & clamped to bound.
 *
 * This is the critical difference from {@link clampScore}: that one is for the
 * always-present `overallScore`; THIS one is for the maybe-absent status score.
 */
export function clampNullableScore(
  v: number | undefined | null,
): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_ROAST_SCORE;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Clamp a raw progress percent (`PortfolioRoast.progress`) to an integer in
 * [0, 100]. `null`/`undefined`/`NaN`/`±Infinity` → 0; `<0` → 0; `>100` → 100.
 * The progress view renders `{progress}%`, so an unclamped value would show
 * `NaN%`, `Infinity%`, `-30%`, or `150%`.
 */
export function clampProgress(v: number | undefined | null): number {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Derive a progress percent from `completed`/`total` step counts, div-by-zero
 * safe. `total <= 0` (an empty / not-yet-initialised pipeline) → 0 rather than
 * `0/0 = NaN`. The ratio is bounded so a `completed > total` overshoot (a
 * double-incremented step counter) can't yield `>100`, and a negative count
 * can't yield `<0`. Non-finite inputs collapse to 0 via {@link finite}.
 *
 * Returns an integer in [0, 100].
 */
export function deriveProgressFromSteps(
  completed: number | null | undefined,
  total: number | null | undefined,
): number {
  const t = finite(total);
  if (t <= 0) return 0;
  const c = finite(completed);
  return clampProgress((c / t) * 100);
}

// ---------------------------------------------------------------------------
// Grade / band mapping (the service's canonical, boundary-correct mapping)
// ---------------------------------------------------------------------------

export type RoastBand =
  | "disaster"
  | "yikes"
  | "rough"
  | "meh"
  | "decent"
  | "solid"
  | "great"
  | "legend";

export interface RoastGrade {
  /** Clamped integer score actually used for the mapping (always [0,100]). */
  score: number;
  /** Single-letter grade A–F. */
  letter: "A" | "B" | "C" | "D" | "F";
  /** Playful band label (parity with the gauge's `getScoreLabel`). */
  band: RoastBand;
}

/**
 * Map a (possibly garbage) score to a canonical, BOUNDARY-CORRECT grade.
 *
 * The input is first run through {@link clampScore}, so a `NaN`/`Infinity`/
 * out-of-range value can NEVER escape the band table — it lands on a real band
 * (50 → "meh"/"C") instead of falling through every `if` to an undefined band.
 *
 * Boundary contract (lower-INCLUSIVE, mirrors the gauge's `< threshold` ladder
 * exactly so the two never disagree):
 *
 *   [0,30)→disaster/F · [30,40)→yikes/F · [40,50)→rough/D · [50,60)→meh/C
 *   [60,70)→decent/C · [70,80)→solid/B · [80,90)→great/B · [90,100]→legend/A
 *
 * So exactly 80 → "great" (NOT "solid"), exactly 90 → "legend", exactly 70 →
 * "solid" — the off-by-one a naive `score > 80` ladder gets wrong at the bound.
 */
export function deriveRoastGrade(score: number | null | undefined): RoastGrade {
  const s = clampScore(score);
  let band: RoastBand;
  let letter: RoastGrade["letter"];
  if (s < 30) {
    band = "disaster";
    letter = "F";
  } else if (s < 40) {
    band = "yikes";
    letter = "F";
  } else if (s < 50) {
    band = "rough";
    letter = "D";
  } else if (s < 60) {
    band = "meh";
    letter = "C";
  } else if (s < 70) {
    band = "decent";
    letter = "C";
  } else if (s < 80) {
    band = "solid";
    letter = "B";
  } else if (s < 90) {
    band = "great";
    letter = "B";
  } else {
    band = "legend";
    letter = "A";
  }
  return { score: s, letter, band };
}

// ---------------------------------------------------------------------------
// Sub-score averaging
// ---------------------------------------------------------------------------

/**
 * Average an array of sub-scores into a single clamped overall score, immune to
 * non-finite members and div-by-zero.
 *
 *   - empty / all-non-finite array → {@link DEFAULT_ROAST_SCORE} (50), NEVER
 *     `0/0 = NaN`.
 *   - each member is run through {@link finite} BEFORE summing, and only finite
 *     members count toward the divisor — so one `NaN` sub-score can't drag the
 *     average to `NaN` and an `Infinity` can't blow it up.
 *   - the result is {@link clampScore}-bounded to [0,100].
 *
 * Used when the service must synthesise an overall from the per-axis breakdown
 * (e.g. a legacy row missing `overallScore`).
 */
export function averageSubScores(
  scores: ReadonlyArray<number | null | undefined>,
): number {
  let sum = 0;
  let count = 0;
  for (const raw of scores) {
    if (raw != null && Number.isFinite(raw)) {
      sum += raw;
      count += 1;
    }
  }
  if (count === 0) return DEFAULT_ROAST_SCORE;
  return clampScore(sum / count);
}

// ---------------------------------------------------------------------------
// Status / lifecycle derivation (Invalid-Date safe)
// ---------------------------------------------------------------------------

/** The terminal roast statuses (the consumer stops polling on these). */
export const TERMINAL_ROAST_STATUSES = ["COMPLETED", "FAILED"] as const;

/**
 * Default "stuck" threshold: a running roast older than this is considered
 * stalled. A roast normally finishes in ~1–2 min; 30 min is a generous ceiling
 * after which the worker has almost certainly died.
 */
export const ROAST_STUCK_THRESHOLD_MS = 30 * 60 * 1000;

export interface RoastLifecycle {
  /** Normalised status (unknown/empty → "FAILED" so the UI never spins forever). */
  status: string;
  /** True iff the status is COMPLETED or FAILED. */
  isTerminal: boolean;
  /** True iff a non-terminal roast has been running past the stuck threshold. */
  isStuck: boolean;
  /** Age in ms, or `null` when `createdAt` is missing/Invalid (never throws). */
  ageMs: number | null;
}

function statusIsTerminal(status: string): boolean {
  return (TERMINAL_ROAST_STATUSES as readonly string[]).includes(status);
}

/**
 * Derive the lifecycle facts the UI needs (terminal? stuck?) WITHOUT ever
 * touching `.toISOString()` on a possibly-Invalid `createdAt`.
 *
 * Safety contract:
 *   - `createdAt` `null`/`undefined`/Invalid-Date (`new Date("garbage")`,
 *     `.getTime() === NaN`) → `ageMs = null`, `isStuck = false`. The dashboard
 *     used to call `.toISOString()` on such a value and 500 with a RangeError;
 *     here it simply degrades to "age unknown".
 *   - an empty/whitespace/unknown `status` → normalised to "FAILED" so a corrupt
 *     row presents as a (terminal) failure instead of an eternal spinner.
 *   - "stuck" only applies to NON-terminal roasts with a known, positive age
 *     past the threshold. A clock skew that makes `createdAt` look like the
 *     future yields a negative age → not stuck (no false alarm).
 *
 * `now` is injectable for deterministic tests.
 */
export function deriveRoastLifecycle(
  status: string | null | undefined,
  createdAt: Date | null | undefined,
  now: number = Date.now(),
  stuckThresholdMs: number = ROAST_STUCK_THRESHOLD_MS,
): RoastLifecycle {
  const normStatus =
    typeof status === "string" && status.trim() !== ""
      ? status.trim()
      : "FAILED";

  const createdMs =
    createdAt instanceof Date ? createdAt.getTime() : Number.NaN;
  const ageMs = Number.isFinite(createdMs) ? now - createdMs : null;

  const isTerminal = statusIsTerminal(normStatus);
  const isStuck =
    !isTerminal &&
    ageMs !== null &&
    ageMs >= 0 &&
    Number.isFinite(stuckThresholdMs) &&
    ageMs >= stuckThresholdMs;

  return { status: normStatus, isTerminal, isStuck, ageMs };
}

// ---------------------------------------------------------------------------
// Consumer-safety shapers — the service maps Prisma rows through these
// ---------------------------------------------------------------------------

/**
 * Raw status row shape (subset of `PortfolioRoast` selected by `getRoastStatus`).
 * `progress`/`score` are typed `number | null | undefined` so a corrupt
 * non-finite value (which TS still types as `number`) is handled at runtime.
 */
export interface RawRoastStatus {
  status: string;
  progress: number | null | undefined;
  currentStep: string | null;
  score: number | null | undefined;
  errorMessage: string | null;
}

export interface SafeRoastStatus {
  status: string;
  /** Integer [0,100], never NaN/Infinity/out-of-range. */
  progress: number;
  currentStep: string | null;
  /** Integer [0,100] or `null` (in-progress). Never NaN/Infinity. */
  score: number | null;
  errorMessage: string | null;
}

/**
 * Shape a raw status row into a fully consumer-safe one: `progress` is a clamped
 * integer (so `{progress}%` can never render `NaN%`/`150%`) and `score` is a
 * clamped integer or `null` (so the gauge's `{score}` and its label/colour band
 * never see a non-finite or out-of-range value). `status`/`currentStep`/
 * `errorMessage` pass through unchanged.
 *
 * This is the single transform `getRoastStatus` returns, so the production path
 * and the unit tests execute identical logic.
 */
export function sanitizeRoastStatusData(raw: RawRoastStatus): SafeRoastStatus {
  return {
    status: raw.status,
    progress: clampProgress(raw.progress),
    currentStep: raw.currentStep,
    score: clampNullableScore(raw.score),
    errorMessage: raw.errorMessage,
  };
}

/**
 * Shape a raw roast LIST row (running / recent / history) so its unsafe numerics
 * are clamped IN PLACE without changing the row's field set: `progress` (when
 * present) → clamped integer; `score` (when present) → clamped integer or
 * `null`. Generic over the row so the descriptive fields
 * (sessionId/mode/broker/…/createdAt) flow through untouched.
 *
 * Each numeric is rewritten ONLY when the row actually carries that key, so:
 *   - the running list (has `progress`, no `score`) gets a safe `progress` and
 *     gains NO phantom `score`;
 *   - the history list (has `score`, no `progress`) gets a safe `score` and
 *     gains NO phantom `progress`;
 *   - the recent list (has both) gets both — with `score` STAYING `null` for an
 *     in-progress roast.
 *
 * Behaviour-preserving for finite, in-range inputs (the values the existing
 * service tests assert pass straight through).
 */
export function sanitizeRoastListItem<
  T extends {
    progress?: number | null | undefined;
    score?: number | null | undefined;
  },
>(raw: T): T {
  const out = { ...raw };
  if ("progress" in raw) {
    (out as { progress: number }).progress = clampProgress(raw.progress);
  }
  if ("score" in raw) {
    (out as { score: number | null }).score = clampNullableScore(raw.score);
  }
  return out;
}
