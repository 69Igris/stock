// TYPE-ONLY, and it must stay that way — MONEY-1255. This module is otherwise
// import-free and every other file in the pair imports IT; a value import would
// make that a runtime cycle. `xbrl-projection.ts` imports only
// `xbrl-financials-logic.ts`, so there is no cycle today either way, but the
// invariant worth keeping is that the detector has no runtime dependencies.
import type { ProjectedFinancials } from "./xbrl-projection";

/**
 * Is THIS filing's scale consistent with the rest of the company's? — MONEY-1235,
 * re-derived against ADJACENT periods in MONEY-1237.
 *
 * Pure: no I/O, no DB, no clock, no vendor.
 *
 * ## The defect this exists to see
 *
 * The F3 reconcile found 28 scale mismatches spread over 15 (symbol, period)
 * filings — factors of 1000x (12), 100x (11), 10x (4) and 10000x (1), in BOTH
 * directions, and each one internally consistent across that filing's own
 * fields. Internally consistent is the tell. Our arithmetic is one code path
 * shared by every filing; if it were wrong it would be wrong everywhere, not
 * for fifteen companies in one direction and eleven in the other. What varies
 * per filing is the filer's own `roundingLabel` — the declaration of the units
 * the document is written in — and a filer that declares lakhs while reporting
 * crores hands us numbers that are internally coherent and externally 100x off.
 *
 * ## Why a vendor comparison could not have been the answer
 *
 * Those 28 are only the ones the VENDOR OVERLAP could expose. 90.7% of the
 * winner periods have no vendor row at all, so the identical defect in a
 * CREATE-only period is invisible to `reconcile()` — and CREATE-only is where
 * the whole quarterly universe lives (prod: 71,450 QUARTERLY filings, ZERO
 * quarterly `stock_financials` rows). A detector that needs Tickertape to be
 * present cannot protect the 90.7%, and Tickertape is what we are switching
 * away from. So the only usable oracle is the company's OWN other filings.
 *
 * ## Quarantine, never auto-correct
 *
 * The founder decision. This module returns a JUDGEMENT; the writer's response
 * is to hold the filing back and count it. Multiplying a suspect figure by an
 * inferred power of ten would be guessing at which side is wrong, and a wrong
 * auto-correction is strictly worse than a gap: a gap is visible and
 * recoverable, a silently "corrected" number is neither.
 *
 * ## MONEY-1237 — the median of the WHOLE history convicted real businesses
 *
 * The MONEY-1235 rule compared a filing against the median of EVERY comparable
 * sibling. Executed against that function by a reviewer, three ordinary company
 * histories came back `SCALE_SUSPECT`:
 *
 * ```
 * reverse merger / large asset injection   -> SCALE_SUSPECT factor 100   (4 fields)
 * pure spin-off of the operating business  -> SCALE_SUSPECT factor 0.01  (4 fields)
 * sustained >=3x/yr growth over 7 filings  -> SCALE_SUSPECT on the newest AND oldest
 * ```
 *
 * The growth one is STRUCTURAL, not a tuning accident. For `n` points at a
 * constant growth rate `r`, newest ÷ median = `r^((n-1)/2)`; at n = 7 that is
 * `r^3`, so **any company compounding >= 3.16x/yr for six years lost its newest
 * and its oldest annual filing**. Reverse listings and asset injections into a
 * small listed shell are routine in India, and the unmoved-field veto could not
 * save any of them: the veto only fires when SOME field barely moved, and a
 * whole-company step change moves everything together.
 *
 * Worse, the whole-history median INVERTS when the mis-scale is the MAJORITY —
 * which is exactly the shape a template-level `roundingLabel` error has. Three
 * mis-scaled siblings plus one correct filing made the median mis-scaled, so
 * the CORRECT filing was quarantined and the three bad ones were written.
 *
 * ## The rule now: a mis-scale is a SPIKE, a business event is a STEP
 *
 * A mis-declared unit is a property of ONE DOCUMENT. In the company's own time
 * series it appears as a spike: the period before it and the period after it
 * are both ~10^k away, in the SAME direction. Every business event that moves
 * the whole company — a merger, a spin-off, a demerger, sustained growth —
 * appears as a STEP or a RAMP: the filing agrees with ONE of its two sides, or
 * its two sides disagree with it in OPPOSITE directions.
 *
 * So the comparison is against the {@link NEIGHBOUR_WINDOW} nearest periods on
 * EACH SIDE of the candidate, never against the whole history, and a conviction
 * requires the same power of ten on both sides:
 *
 * | history                     | older side | newer side | verdict            |
 * | --------------------------- | ---------- | ---------- | ------------------ |
 * | …, 32, **31892**, 32, 33    | x1000      | x1000      | SCALE_SUSPECT      |
 * | …, 12, 12, **1200**, 1250   | x100       | x1         | OK (step: merger)  |
 * | …, 1250, **12**, 12, 13     | x0.01      | x1         | OK (step: spin-off)|
 * | 3x/yr compounder, interior  | x9         | x1/9       | OK (ramp)          |
 *
 * A step is caught by the existing unmoved-field VETO — the side the company
 * settled at is within 3.16x — and a ramp is caught because the two sides
 * round to opposite exponents, which is not agreement.
 *
 * ## The one-sided edge, and why it gets its own verdict
 *
 * The NEWEST filing has no newer neighbour, so a spike and a step are literally
 * the same picture. Refusing to judge it is not an option — after the drain
 * EVERY nightly candidate is a newest filing (MONEY-1237 FIX 3), so a
 * "two-sided or nothing" rule would leave the steady state with zero scale
 * cover. Convicting it is not an option either: that is precisely how the
 * reverse merger was lost.
 *
 * Hence {@link ScaleJudgement} `SCALE_UNCONFIRMED`: the magnitudes disagree
 * with the only side that exists, and one side cannot tell a spike from a step.
 * The writer's response is to HOLD the filing — write nothing, stamp nothing,
 * count it — so the verdict is re-derived on the next run. One reporting period
 * later the candidate has a newer neighbour and the ambiguity resolves itself:
 * a genuine merger lands (the newer side matches, so the veto fires), a genuine
 * mis-scale is convicted. That self-healing is the whole reason MONEY-1237's
 * FIX 2 refuses to stamp a scale verdict.
 *
 * ## What this still cannot do, stated rather than discovered later
 *
 *  1. **A majority mis-scale.** Three consecutive filings written in the wrong
 *     unit and one correct one is information-theoretically undecidable from
 *     magnitudes alone: `good, bad, bad, bad` is the same series as a company
 *     that grew 1000x and stayed there. The rule no longer INVERTS on it — the
 *     correct filing is held, not convicted, and the three bad ones are written
 *     — but it cannot catch the three. That needs a signal outside the series
 *     (the filing's own `roundingLabel` against its own magnitudes).
 *  2. **The 10x tail.** The threshold is |log10| >= 1.5 (~31.6x), so the four
 *     measured 10x comparisons are out of reach. Lowering it would convict a
 *     genuine tenfold year (|log10| = 1.0 exactly).
 *  3. **A holding company judged against the other basis.** Same-basis siblings
 *     are the preferred context tier for this reason; the ladder only widens
 *     when a company has too few of them.
 */

/**
 * The magnitudes worth comparing. Two from each statement on purpose — a
 * detector that only watched the income statement could not tell a mis-declared
 * unit from a genuinely collapsed year, because both move revenue and profit
 * together while leaving the balance sheet alone.
 */
export const SCALE_FIELDS = [
  "revenue",
  "netIncome",
  "totalAssets",
  "totalEquity",
] as const;

export type ScaleField = (typeof SCALE_FIELDS)[number];

/**
 * Which PROJECTED COLUMN each magnitude is read out of — MONEY-1255.
 *
 * The labels above name QUANTITIES, and they are printed as such
 * (`x100 on revenue+netIncome`). The columns they are read from are a separate
 * vocabulary that MONEY-1255 moved underneath them: `ProjectedFinancials.revenue`
 * became `revenueFromOperations` when the vendor's differently-defined `revenue`
 * column stopped being ours to write. Renaming the LABEL would have been the
 * other option and was rejected — the detector's whole output vocabulary, and 84
 * fixture references, are keyed on it, while the quantity it means did not
 * change.
 *
 * What must not happen is what the rename left behind for one commit: two call
 * sites (`observeScale` here-adjacent in the writer, and the F3 reconcile) each
 * reducing a statement with their own `statement[field]` loop, both indexing a
 * key that no longer existed. Both now go through {@link scaleValuesOf}, so the
 * mapping exists once and a future rename breaks the build in one place instead
 * of silently reading `undefined` in two.
 *
 * `satisfies` rather than an annotation: it keeps the literal types AND makes a
 * column that is not on `ProjectedFinancials` a compile error, which is the one
 * failure mode this map can have.
 */
export const SCALE_FIELD_COLUMN = {
  revenue: "revenueFromOperations",
  netIncome: "netIncome",
  totalAssets: "totalAssets",
  totalEquity: "totalEquity",
} as const satisfies Record<ScaleField, keyof ProjectedFinancials>;

/**
 * Reduce projected statements to the magnitudes the detector compares.
 *
 * Callers pass CRORE-denominated statements (`toCroreDenominated`), because
 * that is the unit the write path uses and "a second, subtly different
 * reduction is how a detector ends up clearing a value the writer then
 * mangles". Only ratios are read, so any consistent unit works — but only if it
 * is the same unit on every observation of a symbol, which is why there is one
 * reducer rather than one per caller.
 *
 * A non-number is left ABSENT rather than defaulted: a zero would be a
 * magnitude the filing never stated, and `magnitude()` treats 0 as unevaluable
 * for exactly that reason.
 */
export function scaleValuesOf(
  statements: ReadonlyArray<ProjectedFinancials | null | undefined>,
): ScaleObservation["values"] {
  const values: ScaleObservation["values"] = {};
  for (const statement of statements) {
    if (!statement) continue;
    for (const field of SCALE_FIELDS) {
      const v = statement[SCALE_FIELD_COLUMN[field]];
      if (typeof v === "number") values[field] = v;
    }
  }
  return values;
}

/**
 * One filing reduced to what the detector needs: its magnitudes, its place in
 * the company's time series, and the two columns that decide which siblings are
 * comparable.
 *
 * Values are whatever unit the CALLER uses consistently — the writer passes ₹
 * crore, because that is what it is about to write. Only RATIOS are read, so
 * the unit cancels; what must not vary is the unit BETWEEN candidate and
 * siblings, which is why the writer builds every observation through the same
 * `toCroreDenominated` path.
 */
export interface ScaleObservation {
  /** `XbrlFiling.id`. Used only to exclude the candidate from its own context. */
  filingId: string;
  basis: string;
  periodType: string;
  /**
   * The period this filing describes — MONEY-1237, and the input the
   * adjacent-window rule is built on.
   *
   * OPTIONAL, and the fallback is load-bearing rather than defensive. Callers
   * that predate MONEY-1237 (`scripts/data/xbrl-reconcile.ts`) build their
   * context list straight from `orderBy: [{symbol:"asc"},{periodEnd:"desc"}]`,
   * so within a symbol the ARRAY IS ALREADY IN PERIOD ORDER, newest first. When
   * any observation lacks a date, {@link judgeFilingScale} falls back to that
   * array position — see `resolveOrder`. A caller that supplies neither a date
   * nor a period-ordered array gets `SCALE_UNCONFIRMED` at worst, never a
   * conviction from a scrambled series.
   */
  periodEnd?: Date;
  /** Human label for a report line. No behaviour depends on it. */
  label?: string;
  values: Partial<Record<ScaleField, number | null | undefined>>;
  /**
   * `PaidUpValueOfEquityShareCapital`, as tagged — MONEY-1250 (T3.2).
   *
   * SEPARATE from {@link ScaleObservation.values} and deliberately not a
   * {@link ScaleField}. The neighbour rule DIVIDES this field's siblings and
   * asks whether the candidate moved; paid-up share capital is the one
   * magnitude on the filing that is SUPPOSED not to move, so promoting it into
   * `SCALE_FIELDS` would hand the veto (`LOG10_STABLE`) a field that is stable
   * by construction and switch the neighbour detector off for every company
   * that discloses it. It is read only by {@link judgeCrossBasisPaidUpCapital},
   * which uses it the opposite way round: as an EQUALITY that must hold.
   *
   * Whatever unit the caller uses, consistently — same contract as `values`,
   * and for the same reason: only the ratio between two filings is read, so a
   * shared constant factor cancels. The writer passes the raw rupee tag
   * because `toCroreDenominated` converts `ownedFields` only and this concept
   * is not one (it is not a `StockFinancials` column).
   *
   * Optional because a caller that does not supply it gets the pre-MONEY-1250
   * behaviour exactly: {@link judgeCrossBasisPaidUpCapital} returns null and
   * `judgeFilingScale` falls through to the neighbour rule.
   */
  paidUpEquityShareCapital?: number | null;
  /**
   * `LevelOfRoundingUsedInFinancialStatements`, as the filer declared it.
   *
   * DIAGNOSTIC ONLY — no verdict depends on it, and none may. The label is the
   * filer's claim about the units, and this whole module exists because that
   * claim is sometimes false; a rule keyed on it would be a rule keyed on the
   * defect's own testimony. It is carried so a quarantine line can print
   * `"Lakhs" vs "Crores"`, which is the first thing a human checks.
   */
  roundingLabel?: string | null;
}

export type ScaleJudgement =
  /** Consistent with its neighbours, or not enough fields in common to say. */
  | { verdict: "OK"; siblingPeriods: number }
  /**
   * Fewer than {@link MIN_SIBLING_PERIODS} comparable sibling periods, or none
   * of them sits in a DIFFERENT period from the candidate. NOT a pass and NOT a
   * flag: there is no oracle. A first-ever filer sits here, and so does any
   * symbol whose siblings were all projected on an earlier night and could not
   * be re-fetched.
   */
  | {
      verdict: "INSUFFICIENT_CONTEXT";
      siblingPeriods: number;
      /**
       * WHY there was not enough context — MONEY-1236.
       *
       * The verdict alone is unactionable, and that cost a whole population its
       * quarantine. `xbrl-reconcile.ts` graded QUARTERLY candidates against an
       * ANNUAL-only context; the candidate was not in the array at all, so
       * `resolveOrder`'s index fallback returned null and EVERY quarterly
       * verdict came back INSUFFICIENT_CONTEXT — indistinguishable from a
       * first-ever filer, and therefore invisible, right before a drain that
       * writes exactly that population.
       *
       * - `NO_SIBLINGS` — fewer than `MIN_SIBLING_PERIODS` comparable filings.
       *   The ordinary, benign case: a first-ever filer.
       * - `CANDIDATE_NOT_IN_CONTEXT` — a CALLER BUG. The context has siblings
       *   but does not contain the candidate, so nothing can place it in its own
       *   series. Never benign; count it and fix the caller.
       * - `UNORDERABLE` — no `periodEnd` and no usable array position.
       * - `NO_NEIGHBOURING_PERIOD` — every sibling shares the candidate's
       *   period, so there is no neighbour to be adjacent to.
       */
      reason:
        | "NO_SIBLINGS"
        | "CANDIDATE_NOT_IN_CONTEXT"
        | "UNORDERABLE"
        | "NO_NEIGHBOURING_PERIOD";
    }
  /**
   * The magnitudes disagree with the ONLY neighbouring side that exists —
   * MONEY-1237.
   *
   * The candidate is the newest (or oldest) filing we hold for this company, so
   * a mis-declared unit and a genuine whole-company step change produce the
   * identical picture. This is deliberately NOT a conviction: the writer holds
   * the filing without stamping it, and the next reporting period supplies the
   * missing side and resolves it.
   */
  | {
      verdict: "SCALE_UNCONFIRMED";
      factor: number;
      fields: ScaleField[];
      siblingPeriods: number;
      /** Which side was missing — `NEWER` for the newest filing we hold. */
      missingSide: "OLDER" | "NEWER";
    }
  /**
   * The company's OWN two filings for this period contradict each other on a
   * quantity that is identical by construction — MONEY-1250 (T3.2).
   *
   * See {@link judgeCrossBasisPaidUpCapital} for the invariant and the census.
   * The response is a HOLD, never a correction, and the payload says why: the
   * evidence proves that ONE of the two documents is mis-scaled SOMEWHERE, and
   * it cannot say which document, nor whether the fault is the whole filing or
   * a single mis-tagged element.
   */
  | {
      verdict: "SCALE_BASIS_CONFLICT";
      /**
       * Candidate ÷ counterpart, RAW and DIRECTIONAL — not rounded to a power
       * of ten.
       *
       * Raw on purpose. A whole-filing rounding error is a clean power of ten
       * and a single mis-tagged element usually is not (prod: PDSL FY2025 at
       * 0.00071x, GICL FY2026 at 0.049x, ZEEL FY2019 at 91.9x), so rounding
       * would erase the one number in this payload that hints at which of the
       * two readings applies. The reader can round it; it cannot unround it.
       */
      ratio: number;
      /** The candidate's own tagged paid-up capital, in the caller's unit. */
      paidUpEquityShareCapital: number;
      /** The same concept on the opposite-basis filing for the SAME period. */
      counterpartPaidUpEquityShareCapital: number;
      counterpartFilingId: string;
      counterpartBasis: string;
      /**
       * How much sibling context the NEIGHBOUR rule had, for this verdict too.
       *
       * Present on EVERY variant of this union, and that uniformity is
       * load-bearing rather than cosmetic: `scripts/data/xbrl-reconcile.ts`
       * prints `${j.verdict} (${j.siblingPeriods} sibling period(s))` for any
       * judgement, without narrowing. A variant missing the field is a compile
       * error in a file this ticket may not edit — but more usefully, the
       * number answers the question this verdict provokes. A basis conflict
       * with 9 sibling periods is a filing the neighbour rule looked at and
       * cleared; one with 0 is a filing nothing else could ever have judged,
       * which is the population the invariant was built for.
       */
      siblingPeriods: number;
      /** Both filers' declared rounding, when the caller supplied it. */
      roundingLabel?: string;
      counterpartRoundingLabel?: string;
      /**
       * The readings this verdict CANNOT tell apart, ready to print.
       *
       * Required rather than optional so a quarantine line physically cannot be
       * written without it. A bare "SCALE_BASIS_CONFLICT x100" invites exactly
       * the auto-correction the founder decision forbids, because a lone factor
       * reads like an instruction.
       */
      undecidable: string;
    }
  | {
      verdict: "SCALE_SUSPECT";
      /**
       * Candidate ÷ neighbours, rounded to a power of ten and DIRECTIONAL:
       * `1000` means our figures are a thousand times too large, `0.01` means a
       * hundred times too small. Both directions occur in the measured
       * population (12 filings at 1000x, 11 at 100x, in both directions), so a
       * magnitude-only factor would have thrown away half the diagnosis.
       */
      factor: number;
      /** The fields that agreed, on BOTH sides. Always at least two. */
      fields: ScaleField[];
      siblingPeriods: number;
    };

/**
 * Comparable sibling periods below which there is no oracle at all.
 *
 * THREE, not two, and the difference is not fussiness — it is the whole
 * robustness argument. A median over TWO points is their MEAN, so a single
 * mis-scaled neighbour drags it by ~500x and the detector then convicts the
 * HEALTHY filings around it. Measured on a three-filing fixture (one suspect
 * year, two good ones): every one of the three came back SCALE_SUSPECT, so one
 * bad document would have quarantined a whole short-history symbol.
 *
 * Three is the smallest sample at which the median ignores one outlier
 * entirely, and one outlier is exactly what this module hunts. The cost is
 * coverage — a symbol with three filings or fewer is simply not judged — and
 * that is the right side to err on: an unjudged filing is still reconcilable,
 * a wrongly quarantined one is a period silently dropped.
 *
 * UNCHANGED by MONEY-1237. The adjacent window is drawn FROM this tier, so
 * lowering the floor would not buy coverage — it would only let a symbol with
 * two filings be judged against a single neighbour.
 */
const MIN_SIBLING_PERIODS = 3;

/**
 * Sibling values a single FIELD needs, ACROSS THE WHOLE TIER, before it may
 * vote.
 *
 * Same three, and enforced per field rather than only per tier: a tier of five
 * siblings where only two disclose `totalEquity` gives that column a two-point
 * mean with all the fragility above, while the run looks well-supplied.
 *
 * UNCHANGED by MONEY-1237, and deliberately still counted over the TIER rather
 * than per side. Per-side it would be a different, much harsher floor — the
 * real SILGO FY2021 case has exactly ONE older sibling — and it would have
 * silently switched the detector off for the measured population while looking
 * like a tightening. The per-side outlier defence is not a sample count, it is
 * the two-sided agreement requirement: a single mis-scaled neighbour sits on
 * exactly ONE side and therefore can never make both sides agree.
 */
const MIN_FIELD_SAMPLES = 3;

/**
 * ~31.6x. See the header: far above a tenfold year (1.0), and ABOVE the 10x
 * mismatches — those four are deliberately out of reach, because catching them
 * would mean convicting genuine tenfold years.
 */
const LOG10_THRESHOLD = 1.5;

/** One field can be a business event. Two moving together cannot. */
const MIN_AGREEING_FIELDS = 2;

/**
 * ~3.16x. Below this a field did not meaningfully move, and a field that did
 * not move VETOES the whole flag — see `judgeFilingScale`.
 */
const LOG10_STABLE = 0.5;

/**
 * Neighbouring periods compared on EACH side of the candidate — MONEY-1237.
 *
 * THREE, and the number is a trade between two measured failures:
 *
 *  - Too WIDE and the one-sided (newest/oldest) comparison re-acquires the
 *    growth defect. Against the `w` nearest older periods of a constant-`r`
 *    compounder the median sits at `r^-((w+1)/2)`, so the flag fires at
 *    `r >= 31.6^(2/(w+1))`: w=3 tolerates 5.62x/yr, w=5 tolerates 3.16x/yr —
 *    which is exactly the whole-history median this ticket replaced.
 *  - Too NARROW (w=1) and there is no median at all: one mis-scaled neighbour
 *    becomes the entire oracle for the filing next to it.
 *
 * Three tolerates sustained 5.62x/yr growth at the edge and ~any growth in the
 * interior (the two sides deviate in opposite directions), while still letting
 * the median absorb one bad neighbour. Exported because the writer sizes its
 * sibling FETCH from it — a window that grows without the fetch growing would
 * silently starve itself of exactly the periods it just decided it needs.
 */
export const NEIGHBOUR_WINDOW = 3;

/**
 * Usable magnitude, or undefined.
 *
 * Zero is excluded deliberately even though it is a real value: log10(0) is
 * -Infinity, and a company reporting zero equity for one quarter would
 * otherwise look like an infinite scale error. Sign is dropped because a loss
 * is not a scale defect — TNTELE's FY2024 netIncome is −14,618.8 against
 * neighbours near −14.62, and the defect is the 1000, not the minus.
 */
function magnitude(v: number | null | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const m = Math.abs(v);
  return m > 0 ? m : undefined;
}

/** Median of a non-empty list. Even lengths average the two middle values. */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A sibling contributes nothing unless it carries at least one magnitude. */
function isUsable(o: ScaleObservation): boolean {
  return SCALE_FIELDS.some((f) => magnitude(o.values[f]) !== undefined);
}

/**
 * The narrowest sibling set that is still big enough to be an oracle.
 *
 * Same basis AND same period type first: comparing a standalone quarter against
 * consolidated annuals mixes a holding-company multiple with a 4x seasonal one,
 * and both are noise against the signal. The ladder widens only when a company
 * has too few filings of its own kind, which is exactly when a false negative
 * (no flag) is preferable to a false positive.
 */
function contextTier(
  candidate: ScaleObservation,
  context: readonly ScaleObservation[],
): ScaleObservation[] {
  const siblings = context.filter(
    (o) => o.filingId !== candidate.filingId && isUsable(o),
  );
  const sameBoth = siblings.filter(
    (o) => o.basis === candidate.basis && o.periodType === candidate.periodType,
  );
  if (sameBoth.length >= MIN_SIBLING_PERIODS) return sameBoth;
  const samePeriodType = siblings.filter(
    (o) => o.periodType === candidate.periodType,
  );
  if (samePeriodType.length >= MIN_SIBLING_PERIODS) return samePeriodType;
  return siblings;
}

/** A real, finite `periodEnd`. A Json round-trip yields a string, not a Date. */
function periodTime(o: ScaleObservation): number | undefined {
  const d = o.periodEnd;
  if (!(d instanceof Date)) return undefined;
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Where each observation sits in the company's time series — MONEY-1237.
 *
 * Returns a map from `filingId` to a monotonically INCREASING order value
 * (larger = later period), or `null` when the series cannot be ordered at all.
 *
 * Two sources, in order:
 *
 *  1. **`periodEnd` on every observation that will be compared.** The writer
 *     supplies it, so the production path never uses the fallback.
 *  2. **The caller's array position.** Both callers in this repo build their
 *     context from `orderBy: [{symbol:"asc"},{periodEnd:"desc"}]` and push in
 *     iteration order, so within a symbol index 0 is the NEWEST filing.
 *     Negating the index turns that into the same increasing scale.
 *
 * The two are never mixed: a real epoch millisecond and a small negative index
 * on the same axis would place every dated observation after every undated one,
 * which is not a degraded ordering — it is a wrong one. All-or-nothing instead.
 */
function resolveOrder(
  candidate: ScaleObservation,
  siblings: readonly ScaleObservation[],
  context: readonly ScaleObservation[],
): { order: Map<string, number> } | { failure: "CANDIDATE_NOT_IN_CONTEXT" } {
  const candidateTime = periodTime(candidate);
  if (candidateTime !== undefined) {
    const times = siblings.map(periodTime);
    if (times.every((t): t is number => t !== undefined)) {
      const order = new Map<string, number>();
      order.set(candidate.filingId, candidateTime);
      siblings.forEach((s, i) => order.set(s.filingId, times[i]!));
      return { order };
    }
  }
  // The array-position fallback can only place a candidate the array CONTAINS.
  // A caller that scopes the context to a different population than the
  // candidate belongs to lands here on every single filing — see the `reason`
  // docs on INSUFFICIENT_CONTEXT for what that cost.
  const index = context.findIndex((o) => o.filingId === candidate.filingId);
  if (index < 0) return { failure: "CANDIDATE_NOT_IN_CONTEXT" };
  const order = new Map<string, number>();
  context.forEach((o, i) => order.set(o.filingId, -i));
  return { order };
}

/** The `n` siblings nearest to `at`, on one side, nearest first. */
function nearestSide(
  siblings: readonly ScaleObservation[],
  order: Map<string, number>,
  at: number,
  side: "OLDER" | "NEWER",
  n: number,
): ScaleObservation[] {
  return siblings
    .filter((o) => {
      const t = order.get(o.filingId);
      if (t === undefined) return false;
      // A sibling sharing the candidate's period is not a NEIGHBOUR — it is
      // another view of the same period (the other basis, a cumulative
      // roll-up). Comparing against it measures the view, not the units.
      return side === "OLDER" ? t < at : t > at;
    })
    .sort(
      (a, b) =>
        Math.abs(order.get(a.filingId)! - at) -
          Math.abs(order.get(b.filingId)! - at) ||
        // Deterministic under equal distance, so a verdict is a function of the
        // candidate SET and not of the order the query happened to return.
        a.filingId.localeCompare(b.filingId),
    )
    .slice(0, n);
}

/** What one field's magnitudes say about the candidate, side by side. */
interface FieldEvidence {
  field: ScaleField;
  exponent: number;
  /** How many neighbouring sides agreed on that exponent. 1 or 2. */
  sides: number;
}

/**
 * The smallest cross-basis paid-up disagreement that is read as a defect —
 * MONEY-1250 (T3.2).
 *
 * 9.5x, i.e. "a factor of ten, allowing 5% for the filer's own rounding". The
 * floor is high on purpose and the reason is structural rather than a tuning
 * choice: a mis-declared unit is a POWER OF TEN, so the smallest one that can
 * exist is 10x (Lakhs vs Millions, and prod has both directions of it —
 * MARKSANS FY2025 at 0.1x, FLEXITUFF FY2024 at 10x). Anything below 10x
 * therefore cannot be the defect this looks for, and a lower floor would only
 * buy the shapes that ARE legitimately possible here: an ESOP-trust
 * elimination, a part-paid tranche, a rights issue recorded on one basis
 * before the other.
 *
 * Measured on prod 2026-08-26 over all 96,063 filings. Both sides must state a
 * NON-ZERO value; grouping is (symbol, exchange, periodEnd, periodType,
 * cumulative):
 *
 *     ANNUAL        45 period(s) of 12,3xx with both bases present
 *     QUARTERLY    118
 *     HALF_YEARLY    3
 *
 * The zero exclusion is not tidiness. 732 filings tag paid-up capital as a
 * literal 0, and admitting them takes QUARTERLY from 118 to 546 and ANNUAL
 * from 45 to 80 — a lazy zero is an absent tag wearing a number, which is the
 * MONEY-1234 defect, not a scale one, and quarantining on it would blame the
 * scale rule for something a different rule already understands.
 */
export const BASIS_CONFLICT_MIN_FACTOR = 9.5;

/** CONSOLIDATED vs consolidated. Callers differ; the domain is binary. */
function sameBasis(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * A usable, STATED paid-up figure: finite and strictly positive.
 *
 * ONE rule, in ONE place, and that is deliberate — a first draft rejected zero
 * here AND again downstream (`!Number.isFinite(ratio) || ratio <= 0`), and
 * mutation testing showed the downstream copy absorbed every case, so deleting
 * this guard changed no test. That is the definition of dead logic, and this
 * repo has deleted a clause for exactly that reason before (the
 * `impliedAttributable !== 0` case in `xbrl-projection.ts`). The redundant
 * copy is gone; with both operands finite and positive the ratio is finite and
 * positive by construction, so nothing downstream needs to re-check it.
 *
 * ZERO is excluded because a zero paid-up tag is an ABSENT tag wearing a
 * number — 732 prod filings carry one — and admitting them takes the QUARTERLY
 * census from 118 to 546. NEGATIVE is excluded because share capital cannot be
 * negative: such a filing has a defect this rule is not equipped to adjudicate,
 * and declining is not the same as passing.
 */
function paidUp(o: ScaleObservation): number | undefined {
  const v = o.paidUpEquityShareCapital;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

/**
 * Does this filing contradict its own opposite-basis twin? — MONEY-1250 (T3.2).
 *
 * ## The invariant
 *
 * `PaidUpValueOfEquityShareCapital` is the PARENT's issued share capital. A
 * company files the same period twice — CONSOLIDATED and STANDALONE — and
 * consolidation changes what is underneath the parent, never the parent's own
 * share capital. So the two filings must state the SAME number, to the rupee,
 * by construction. When they differ by a factor of ten or more, at least one of
 * those two documents contains a magnitude that cannot be right.
 *
 * ## Why this and not more neighbours
 *
 * The neighbour rule needs {@link MIN_SIBLING_PERIODS} comparable periods and
 * a period on each side. Measured on prod 2026-08-26 under the writer's own
 * nightly scoping, 123 winner periods have ZERO comparable siblings and 455
 * have exactly one — **578 filings the neighbour rule cannot judge at all**,
 * and its recall over the population the vendor can independently expose is
 * 31% (5 of 16 filings). This check needs no siblings, no ordering, no vendor
 * and no history: the counterpart is the filing sitting in the SAME period
 * group the writer already assembled, because `groupKey` does not include
 * `basis`.
 *
 * ## QUARANTINE, and the reason it can never be a correction
 *
 * The evidence is symmetric. It proves the pair disagrees; it cannot say which
 * side is wrong, because either document could be the mis-declared one. Nor
 * can it say whether the fault is the WHOLE filing or a single element: prod
 * carries clean examples of both under the same signature —
 *
 *     TRENT     FY2022  CONS "Lakhs" vs STAN "Crores", 0.01x. The consolidated
 *                       revenue series breaks 2592.96 -> 44.98 -> 8242.02, so
 *                       the whole document is mis-scaled.
 *     SHK       FY2023  1,000,006x with BOTH bases labelled "Crores" and no
 *                       other magnitude disturbed — plainly one mis-tagged
 *                       element, and the rest of the filing is fine.
 *
 * A rule that multiplied by the observed factor would be right for TRENT and
 * would destroy SHK, and `stock_financials` has no `source` in its unique key,
 * so it destroys it permanently. Hence one verdict for both, carrying
 * {@link ScaleJudgement} `undecidable` — the sentence that says, in the
 * quarantine line itself, which two readings the evidence did not separate.
 *
 * ## The counterpart chosen is the most CHARITABLE one
 *
 * Where a period somehow holds several opposite-basis filings, the one whose
 * paid-up value is CLOSEST to the candidate's wins. A conflict is then reported
 * only when even the friendliest available reading still disagrees by
 * {@link BASIS_CONFLICT_MIN_FACTOR}, which is the direction to err in for a
 * check whose cost is a period that never gets written.
 *
 * Returns null — never a verdict — when the invariant cannot be evaluated:
 * either side missing the tag, either side tagging zero, no `periodEnd` to
 * identify "the same period" with, or no opposite-basis filing at all. A
 * caller that supplies none of the new fields therefore sees no behaviour
 * change whatsoever.
 */
export function judgeCrossBasisPaidUpCapital(
  candidate: ScaleObservation,
  context: readonly ScaleObservation[],
): Extract<ScaleJudgement, { verdict: "SCALE_BASIS_CONFLICT" }> | null {
  const ours = paidUp(candidate);
  if (ours === undefined) return null;
  // The period must be IDENTIFIED, not merely ordered. `resolveOrder`'s
  // array-position fallback places a filing in a sequence; it cannot say that
  // two filings describe the same period, and guessing that from adjacency
  // would compare a consolidated FY2024 against a standalone FY2023 — a real
  // disagreement about a real thing, reported as a units bug.
  const at = periodTime(candidate);
  if (at === undefined) return null;

  let best: {
    sibling: ScaleObservation;
    theirs: number;
    ratio: number;
  } | null = null;
  for (const o of context) {
    if (o.filingId === candidate.filingId) continue;
    if (o.periodType !== candidate.periodType) continue;
    if (sameBasis(o.basis, candidate.basis)) continue;
    if (periodTime(o) !== at) continue;
    const theirs = paidUp(o);
    if (theirs === undefined) continue;
    // Finite and positive by construction — `paidUp` is the single guard, see
    // its doc for why re-checking here would be dead logic rather than defence.
    const ratio = ours / theirs;
    // Closest to 1 on a log scale, so "most charitable" is symmetric in the
    // direction of the error — 0.1x and 10x are equally far from agreement.
    if (
      best === null ||
      Math.abs(Math.log10(ratio)) < Math.abs(Math.log10(best.ratio))
    )
      best = { sibling: o, theirs, ratio };
  }
  if (best === null) return null;

  const spread = best.ratio >= 1 ? best.ratio : 1 / best.ratio;
  if (spread < BASIS_CONFLICT_MIN_FACTOR) return null;

  const label = (o: ScaleObservation): string | undefined =>
    typeof o.roundingLabel === "string" && o.roundingLabel.length > 0
      ? o.roundingLabel
      : undefined;
  const oursLabel = label(candidate);
  const theirsLabel = label(best.sibling);
  return {
    verdict: "SCALE_BASIS_CONFLICT",
    ratio: best.ratio,
    paidUpEquityShareCapital: ours,
    counterpartPaidUpEquityShareCapital: best.theirs,
    counterpartFilingId: best.sibling.filingId,
    counterpartBasis: best.sibling.basis,
    // Computed HERE rather than handed down by `judgeFilingScale`, so this
    // function returns a complete verdict on its own and a direct caller gets
    // the same shape the composed entry point produces.
    siblingPeriods: contextTier(candidate, context).length,
    ...(oursLabel !== undefined ? { roundingLabel: oursLabel } : {}),
    ...(theirsLabel !== undefined
      ? { counterpartRoundingLabel: theirsLabel }
      : {}),
    undecidable:
      `paid-up equity share capital is identical across bases by construction, ` +
      `so one of these two filings is mis-scaled — cannot distinguish ` +
      `WHICH SIDE (${candidate.basis} vs ${best.sibling.basis}) nor whether ` +
      `the WHOLE FILING is mis-declared or a SINGLE ELEMENT is mis-tagged; ` +
      `held, never corrected`,
  };
}

/**
 * Judge one filing's scale against the company's ADJACENT filings, and against
 * its own opposite-basis twin.
 *
 * `context` is every observation for the SAME SYMBOL that the caller already
 * holds — the candidate may be in it and is filtered out by `filingId`. The
 * writer reads filings symbol-major (`orderBy: [symbol asc, periodEnd desc]`)
 * and `dropPartialTrailingSymbol` guarantees whole symbols per page, so the
 * in-page siblings cost no query; the ones projected on an earlier night are
 * fetched by ONE grouped query per page (MONEY-1237 FIX 3). Either way the
 * context is a parameter rather than something fetched here, because this
 * module is pure.
 *
 * ## Two rules, and the order between them — MONEY-1250 (T3.2)
 *
 * `SCALE_SUSPECT` outranks `SCALE_BASIS_CONFLICT` because it says strictly
 * more: it names the offending filing, the direction and the power of ten,
 * corroborated on both sides by two independent fields. The basis conflict
 * names a PAIR. Where both fire, reporting the weaker one would throw away a
 * diagnosis the operator can act on — and both hold the filing either way, so
 * the choice costs nothing in coverage.
 *
 * Everything else the basis conflict outranks, and that is the whole point of
 * it: `INSUFFICIENT_CONTEXT`, `SCALE_UNCONFIRMED` and `OK` are all outcomes the
 * neighbour rule reaches when it has no oracle or an inconclusive one, and the
 * invariant needs neither.
 */
export function judgeFilingScale(
  candidate: ScaleObservation,
  context: readonly ScaleObservation[],
): ScaleJudgement {
  const byNeighbours = judgeByNeighbouringPeriods(candidate, context);
  if (byNeighbours.verdict === "SCALE_SUSPECT") return byNeighbours;
  return judgeCrossBasisPaidUpCapital(candidate, context) ?? byNeighbours;
}

/** The MONEY-1237 adjacent-window rule. See {@link judgeFilingScale}. */
function judgeByNeighbouringPeriods(
  candidate: ScaleObservation,
  context: readonly ScaleObservation[],
): ScaleJudgement {
  const siblings = contextTier(candidate, context);
  if (siblings.length < MIN_SIBLING_PERIODS) {
    return {
      verdict: "INSUFFICIENT_CONTEXT",
      siblingPeriods: siblings.length,
      reason: "NO_SIBLINGS",
    };
  }

  const resolved = resolveOrder(candidate, siblings, context);
  if ("failure" in resolved) {
    // Nothing places the candidate in its own series, so "adjacent" has no
    // meaning. Reporting OK here would be a silent pass on an unjudged filing —
    // the outcome MONEY-1237 FIX 3 exists to stop being invisible. The `reason`
    // is what makes a CALLER BUG distinguishable from a first-ever filer.
    return {
      verdict: "INSUFFICIENT_CONTEXT",
      siblingPeriods: siblings.length,
      reason: resolved.failure,
    };
  }
  const order = resolved.order;
  const at = order.get(candidate.filingId)!;
  const older = nearestSide(siblings, order, at, "OLDER", NEIGHBOUR_WINDOW);
  const newer = nearestSide(siblings, order, at, "NEWER", NEIGHBOUR_WINDOW);
  const sides = [older, newer].filter((s) => s.length > 0);
  if (sides.length === 0) {
    // Every comparable sibling shares the candidate's period. Same reasoning as
    // above: there is no neighbouring period to be adjacent to.
    return {
      verdict: "INSUFFICIENT_CONTEXT",
      siblingPeriods: siblings.length,
      reason: "NO_NEIGHBOURING_PERIOD",
    };
  }

  const flagged: FieldEvidence[] = [];
  let stableFields = 0;
  for (const field of SCALE_FIELDS) {
    const ours = magnitude(candidate.values[field]);
    if (ours === undefined) continue;
    // The TIER-level sample floor, unchanged from MONEY-1235: a field that only
    // two filings anywhere disclose has no median worth the name, whichever
    // side those two land on.
    const tierSamples = siblings
      .map((o) => magnitude(o.values[field]))
      .filter((m): m is number => m !== undefined);
    if (tierSamples.length < MIN_FIELD_SAMPLES) continue;

    const logs: number[] = [];
    for (const side of sides) {
      const theirs = side
        .map((o) => magnitude(o.values[field]))
        .filter((m): m is number => m !== undefined);
      if (theirs.length === 0) continue;
      const log = Math.log10(ours / median(theirs));
      if (Number.isFinite(log)) logs.push(log);
    }
    if (logs.length === 0) continue;

    if (logs.every((l) => Math.abs(l) >= LOG10_THRESHOLD)) {
      const exponents = logs.map((l) => Math.round(l));
      // AGREEMENT ACROSS SIDES — MONEY-1237, and this single condition is what
      // separates a rescale from a ramp. A mis-declared unit puts the candidate
      // 10^k away from the period before AND the period after, in the SAME
      // direction. A company on a steep growth curve is far above its older
      // side and equally far BELOW its newer one, so the two exponents are +k
      // and −k and there is nothing to agree about.
      if (exponents.every((e) => e === exponents[0])) {
        flagged.push({
          field,
          exponent: exponents[0]!,
          sides: exponents.length,
        });
      }
    } else if (logs.some((l) => Math.abs(l) < LOG10_STABLE)) {
      stableFields++;
    }
    // Between the two thresholds (3.16x to 31.6x) a field is neither evidence
    // nor a veto. Ordinary businesses live there — a tenfold year is 1.0 — and
    // so does a mis-scaled field whose neighbouring median is unusually noisy.
  }

  if (flagged.length < MIN_AGREEING_FIELDS) {
    return { verdict: "OK", siblingPeriods: siblings.length };
  }
  // AGREEMENT ACROSS FIELDS, not merely a count. Two fields off by different
  // powers of ten is not the mis-declared-rounding signature — that defect is
  // internally consistent across the filing by construction, because one
  // declared unit scales every fact in the document. Disagreeing exponents mean
  // something else is going on and quarantining would be a guess.
  const exponent = flagged[0]!.exponent;
  if (flagged.some((f) => f.exponent !== exponent)) {
    return { verdict: "OK", siblingPeriods: siblings.length };
  }

  // ── The veto, and it is the rule that makes this usable on real filings ──
  //
  // A declared unit scales EVERY fact in the document. So a comparable field
  // that did not move AT ALL against one of its neighbouring sides falsifies
  // the hypothesis outright: whatever happened to this company, it was not a
  // units error.
  //
  // Without this, the two-field rule alone convicts an ordinary demerger. A
  // company that sells its operating division reports revenue AND profit down
  // ~40x while total assets barely move (the business became cash), which lands
  // exactly on "two fields agreeing on 10^-2" — a real, correct period
  // quarantined permanently and invisibly.
  //
  // MONEY-1237 made the veto side-aware, and that is what retires the reverse
  // merger and the spin-off. After a whole-company step change EVERY field
  // matches the side the company settled at, so a filing on the far side of the
  // step now vetoes on all four fields instead of on none.
  //
  // The cost is stated rather than discovered: a genuine 1000x mis-scale whose
  // fourth field happens to sit within 3.16x of one noisy neighbouring median
  // is now MISSED, and a miss writes the wrong number. That is accepted because
  // the veto only fires when a field is essentially unchanged, which the
  // mis-scale hypothesis says is impossible; and because a filing whose
  // projection fills only two fields — every income-only quarterly filing — has
  // nothing that can veto it and is fully covered.
  if (stableFields > 0) {
    return { verdict: "OK", siblingPeriods: siblings.length };
  }

  const factor =
    // `10 ** -4` is 0.00009999999999999999, not 0.0001 — the negative exponents
    // are the ones a reader compares against a round number in a report line,
    // and half the measured population points that way.
    exponent >= 0 ? 10 ** exponent : 1 / 10 ** -exponent;
  const fields = flagged.map((f) => f.field);

  // A CONVICTION needs the spike confirmed on both sides by at least as many
  // independent fields as the flag itself needs. One side cannot tell a spike
  // from a step, and a step is a real business event — see the header.
  const corroborated = flagged.filter((f) => f.sides >= 2).length;
  if (corroborated < MIN_AGREEING_FIELDS) {
    return {
      verdict: "SCALE_UNCONFIRMED",
      factor,
      fields,
      siblingPeriods: siblings.length,
      missingSide: newer.length === 0 ? "NEWER" : "OLDER",
    };
  }

  return {
    verdict: "SCALE_SUSPECT",
    factor,
    fields,
    siblingPeriods: siblings.length,
  };
}
