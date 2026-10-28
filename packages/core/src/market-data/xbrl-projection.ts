/**
 * XBRL → the reader-facing tables, and the ratios derived from them.
 *
 * MONEY-1115 (Data Engine P10 F3). Pure: no I/O, no DB, no clock.
 *
 * ## What this module is FOR
 *
 * `XbrlFiling` holds the filing as filed — 55 canonical concepts, the taxonomy
 * that defined them, and the context that scoped them. `StockFinancials` and
 * `StockRatios` are what the product reads: five fixed buckets of `Float?`,
 * sourced until now from Tickertape. This module is the seam between them.
 *
 * It does three things, all pure:
 *   1. PROJECT a parsed filing into the flat StockFinancials shape.
 *   2. DERIVE ratios from a filing (and, where a ratio needs a prior period,
 *      from a pair of filings).
 *   3. RECONCILE our value against Tickertape's, so the switchover is evidenced
 *      rather than asserted.
 *
 * ## Why the switchover needs a declared AUTHORITY ORDER
 *
 * `StockFinancials` has no `source` in its unique key, so two sources writing
 * the same period silently resolve to "whoever wrote last". That is exactly the
 * bug MONEY-1175 was: Yahoo and the bhavcopy both wrote `close`, no winner was
 * declared, and the last writer won — which happened to be the wrong one, for
 * months, invisibly.
 *
 * So the order is DECLARED here, in one place, as data. XBRL outranks
 * Tickertape because it is the filing rather than a reading of it — but only
 * when the filing actually carried the concept. `chooseAuthority` returns the
 * loser too, so a projection can record what it displaced instead of erasing it.
 *
 * ## Why reconciliation is part of the module and not a script
 *
 * "Validate against Tickertape, then switch readers over" is only meaningful if
 * disagreement is CLASSIFIED. A 0.4% difference on revenue is rounding (₹ lakh
 * vs ₹ crore); a 3× difference is a units error; a sign flip is a
 * discontinued-operations mismatch. A single "matches: true/false" would make
 * all three look the same and would put the burden of judgement on whoever
 * reads the report — which is how a switchover gets approved on a number nobody
 * actually understood.
 */

import type {
  RatioInputs,
  XbrlConcept,
  XbrlFinancials,
} from "./xbrl-financials-logic";
import { rupeesToCrores } from "./xbrl-financials-logic";

// ─── Authority ───────────────────────────────────────────────────────

/**
 * Who wins when two sources describe the same (symbol, period, statement).
 *
 * Lower index wins. Stored as an ordered list rather than a numeric rank so
 * that inserting a source is a one-line change that cannot silently renumber
 * the others.
 *
 * NSE_XBRL leads because it IS the filing. TICKERTAPE and SCREENER are
 * third-party readings of that same filing, and YAHOO is a reading of a reading
 * with the loosest period semantics of the four.
 */
export const FINANCIALS_AUTHORITY = [
  "NSE_XBRL",
  // MONEY-1255 — a model's reading of a company's own filed PDF, ranked SECOND
  // by founder decision, above both vendors and below only an NSE XBRL filing.
  //
  // The case for it: an annual report is a PRIMARY source. Tickertape and
  // Screener are scrapes OF that same document, so ranking them above it puts a
  // third party's reading of a filing ahead of the filing itself, and a vendor
  // error is not more trustworthy than ours merely because it arrived first.
  // The XBRL filing still outranks it, because that is the same company's own
  // numbers in a machine-readable form with no reading step at all.
  //
  // The case against, which is why the interlock below matters: this position
  // means a DOC_PDF write can DISPLACE a vendor value, and `StockFinancials`
  // carries no `source` in its unique key — the displaced number is gone. At
  // the previous position (above YAHOO only) a bad reading could at worst fill
  // an empty cell. Here it can destroy a good one.
  //
  // What makes that acceptable is that the write is gated three deep, not
  // ranked-and-released: the projection refuses any extract the reconcile has
  // not GRADED (`requireGraded`, default true), the reconcile is a separate
  // deliberate run, and `DOC_FINANCIALS_APPLY` ships PRESENT and "false". The
  // displaced value is also preserved in `rawData` on the way out. Rank decides
  // who wins a contest; it does not decide whether the contest is held.
  "DOC_PDF",
  "TICKERTAPE",
  "SCREENER",
  "YAHOO",
] as const;

export type FinancialsSource = (typeof FINANCIALS_AUTHORITY)[number];

export interface AuthorityDecision {
  winner: FinancialsSource;
  /**
   * The source that lost, when there was one. Returned rather than discarded so
   * a writer can RECORD what it displaced — MONEY-1175's lesson is that a
   * silent overwrite is indistinguishable from never having had the other
   * value.
   */
  displaced: FinancialsSource | null;
  /** True when the incumbent outranks the challenger and must be left alone. */
  keepIncumbent: boolean;
}

function rankOf(s: string): number {
  const i = (FINANCIALS_AUTHORITY as readonly string[]).indexOf(s);
  // An unknown source ranks LAST rather than being rejected. A new upstream
  // appearing must not crash a write path, and ranking it last means it can
  // only ever fill a gap, never displace something known.
  return i === -1 ? FINANCIALS_AUTHORITY.length : i;
}

/**
 * Decide whether `challenger` may overwrite `incumbent`.
 *
 * An absent incumbent always loses — filling an empty cell is not a conflict.
 * Equal rank means the SAME source re-writing itself, which is a refresh and is
 * allowed: a corrected filing must be able to replace its own earlier reading.
 */
export function chooseAuthority(
  challenger: string,
  incumbent: string | null,
): AuthorityDecision {
  if (incumbent === null) {
    return {
      winner: challenger as FinancialsSource,
      displaced: null,
      keepIncumbent: false,
    };
  }
  const c = rankOf(challenger);
  const i = rankOf(incumbent);
  if (c <= i) {
    return {
      winner: challenger as FinancialsSource,
      displaced: incumbent as FinancialsSource,
      keepIncumbent: false,
    };
  }
  return {
    winner: incumbent as FinancialsSource,
    displaced: null,
    keepIncumbent: true,
  };
}

/**
 * "May `challenger` write over what is already in this row?" — the one-line
 * question every WRITER actually has.
 *
 * ## Why this exists at all, given `chooseAuthority` is right there
 *
 * `chooseAuthority` answers a richer question (who won, what was displaced,
 * should the incumbent stand) because the projection writer needs all three to
 * build its displacement record. Every OTHER writer needs only the boolean, and
 * by MONEY-1204 there were four of them that had each begun to answer it
 * themselves — `financial-data-sync.ts` correctly, via a private helper; the
 * three in `packages/research` not at all.
 *
 * The risk being closed is NOT "a writer forgets the guard" — a source scan
 * catches that (`packages/core/__tests__/market-data/financials-write-authority.test.ts`).
 * It is the subtler one: four call sites each re-deriving `!keepIncumbent`, or
 * worse each hand-rolling `source !== "NSE_XBRL"`, is FOUR COPIES OF THE
 * ORDERING. Adding a fifth source then has to find all four, and the ones it
 * misses do not error — they silently keep letting a lower-ranked source win,
 * which is precisely the MONEY-1175 shape this table was introduced to end.
 * A second copy of the order is the actual defect; this function is what makes
 * having one unnecessary.
 *
 * Deliberately kept PURE — no Prisma, no I/O. The caller reads the incumbent's
 * `source` (a `findUnique` on the model's own unique key) and hands the string
 * in. That keeps the decision testable without a database and keeps this module
 * free of a dependency it must never grow.
 *
 * Returns TRUE when the write may proceed:
 *   - the row is ABSENT (`null`/`undefined` incumbent) — filling an empty cell
 *     is not a conflict, so there is nothing to protect;
 *   - the challenger OUTRANKS the incumbent;
 *   - the challenger EQUALS the incumbent — a source refreshing its own row is
 *     a correction, not a displacement.
 *
 * Returns FALSE only when a strictly higher-ranked source already owns the row.
 */
export function mayOverwriteFinancials(
  challenger: string,
  incumbentSource: string | null | undefined,
): boolean {
  return !chooseAuthority(challenger, incumbentSource ?? null).keepIncumbent;
}

// ─── Projection ──────────────────────────────────────────────────────

/**
 * The flat shape `StockFinancials` stores. Every field optional, because an
 * absent concept must stay absent — a filing that did not disclose EBITDA is
 * not a filing whose EBITDA is zero.
 */
export interface ProjectedFinancials {
  statementType: "INCOME" | "BALANCE_SHEET";
  /**
   * Revenue from operations, EXCLUDING other income — MONEY-1255.
   *
   * ## Why this is not called `revenue`
   *
   * Because `StockFinancials.revenue` is a DIFFERENT QUANTITY and still holds
   * the vendor's number. Theirs is TOTAL INCOME (this plus `otherIncome`), the
   * projection no longer owns that column, and the two now sit side by side in
   * one row. A key named `revenue` here would land in `revenue` there — the
   * keys of this interface ARE column names, which is the whole contract
   * `projectedValues` rests on — so the rename is what makes the separation
   * real rather than a comment.
   *
   * Read straight off `RevenueFromOperations` (or a lender's `InterestEarned`);
   * nothing is derived, so there is no convention to get wrong.
   */
  revenueFromOperations?: number;
  grossProfit?: number;
  /**
   * Non-operating income, carried as its own value — MONEY-1250.
   *
   * Not a display field. It is the COMPONENT that makes the operating-vs-total
   * EBITDA question reversible: `ebitdaBeforeExceptionalItems` here is
   * PBT-derived and therefore INCLUDES it, so
   * `ebitdaBeforeExceptionalItems - otherIncome` reconstructs the
   * operations-only figure without a second write path or a destroyed column.
   */
  otherIncome?: number;
  /**
   * EBIT struck on {@link revenueFromOperations} alone — MONEY-1255.
   *
   * `revenueFromOperations - totalExpenses + financeCosts` (a lender's
   * `operatingProfitBeforeProvisions`). The vendor's `operatingIncome` column
   * is EBIT INCLUDING other income, so the two differ by exactly that line and
   * the gate reconstructs theirs as `ours + otherIncome`. Same reasoning as
   * the field above: the plain name belongs to the vendor's column.
   */
  operatingIncomeExOtherIncome?: number;
  netIncome?: number;
  /**
   * `profitBeforeTax + financeCosts + depreciationAndAmortisation`, less any
   * exceptional items the filing declares — MONEY-1255.
   *
   * NOT `ebitdaExOtherIncome`. PBT is struck after other income, so this
   * figure INCLUDES it — the vendor's `ebitda` is the operations-only one, the
   * opposite of the direction the other two fields run in. Measured by the
   * gate: `ours - otherIncome` reconstructs the vendor on 66 pairs, while
   * `ours + exceptionalItems` reconstructs it on 824. Exceptional items are
   * the dominant difference, so that is what the name states.
   */
  ebitdaBeforeExceptionalItems?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  totalDebt?: number;
  totalCash?: number;
}

export interface ProjectionResult {
  income: ProjectedFinancials | null;
  balanceSheet: ProjectedFinancials | null;
  /**
   * Fields we could have filled and did not, with the concept that was missing.
   * The point of the module: an absent number is reported as absent WITH its
   * cause, rather than being inferable only from a gap.
   */
  unfilled: Array<{ field: string; needed: XbrlConcept[] }>;
}

/** Finite-only read. `0` is a real value and is kept; NaN/Infinity are not. */
function num(
  values: Partial<Record<XbrlConcept, number>>,
  key: XbrlConcept,
): number | undefined {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The same finite-only rule for a value that arrived OUTSIDE `values` — the
 * `reportedIncome` fallbacks (MONEY-1346). Kept separate from `num` rather than
 * loosening it: `num` takes a CONCEPT key, and widening it to `string` would
 * let a typo compile.
 */
function finite(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * A LENDER — the families for which an interest add-back is meaningless.
 *
 * MONEY-1200 split `nbfc` out of `banking`, and the reason EBITDA is skipped
 * applies identically to both: interest is a lender's COST OF GOODS, so adding
 * it back to PBT yields a number with no meaning. Written as an explicit list
 * rather than `!== "ind-as"` so a future family has to be classified
 * deliberately instead of inheriting a default.
 *
 * ## Why this is module-level, and not three local `isBank`/`isLender` consts
 *
 * MONEY-1239. It WAS three — one in `projectFinancials`, one in `deriveRatios`,
 * and none at all in `deriveTtm`, which is how the third one went missing:
 * `deriveTtm` rebuilds EBITDA from the same `PBT + financeCosts + D&A` route
 * the other two refuse for lenders, hands it to `deriveValuation` as
 * `ttmEbitda`, and `evToEbitda` was written for every NBFC in the universe —
 * the exact number this module twice declines to produce. Banks escaped only by
 * accident: they file no `DepreciationDepletionAndAmortisationExpense`, so the
 * sum happened to have a missing part.
 *
 * That is the same defect `basisRank` and `FINANCIALS_AUTHORITY` were pulled
 * into one place for: a rule copied per call site is a rule that is only as
 * complete as its least-updated copy, and the copies do not disagree loudly —
 * they disagree by writing a plausible number into a column.
 */
export function isLenderFamily(
  family: XbrlFinancials["family"] | undefined,
): boolean {
  return family === "banking" || family === "nbfc";
}

/**
 * Sum, but only when EVERY part is present.
 *
 * Returns undefined if any input is missing, rather than treating a missing
 * part as zero. A total assembled from half its components is worse than no
 * total: it is plausible, it is wrong, and nothing about it says so.
 */
function sumAll(parts: Array<number | undefined>): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (p === undefined) return undefined;
    total += p;
  }
  return Number.isFinite(total) ? total : undefined;
}

/**
 * Project a parsed filing into the flat reader shape.
 *
 * ## EBITDA is DERIVED and that is a real decision
 *
 * No Indian filing discloses EBITDA — it is not an Ind-AS or RBI concept. It is
 * built here as PBT + finance costs + depreciation, and ONLY when all three are
 * present. Two consequences worth stating:
 *
 *   - It EXCLUDES other income, which some vendors include. That makes our
 *     EBITDA legitimately lower than Tickertape's for companies with material
 *     treasury income, and `reconcile` classifies that as a DEFINITION
 *     difference rather than an error. A reconciliation that flagged it as a
 *     mismatch would generate noise forever and get ignored.
 *   - It is NOT computed for banks. Finance cost IS a bank's cost of goods;
 *     adding interest expended back produces a number with no meaning. The
 *     banking family is skipped rather than approximated.
 */
/**
 * How much of a filing's `exceptionalItems` must be removed from a PBT-derived
 * figure — MONEY-1239. Returns 0 when there is nothing to remove or when the
 * filing cannot vouch for its own sign convention.
 *
 * ## Why this exists
 *
 * `ebitda = PBT + financeCosts + depreciation` inherits whatever exceptional
 * charge sits inside PBT, and an exceptional item is by definition the one
 * thing an operating-earnings number should not contain. BHARTIARTL Q2-FY20
 * consolidated is the case that makes it concrete: a −30,711 crore AGR
 * provision turns a +8,928 crore EBITDA into −21,783 — a SIGN FLIP, which then
 * feeds `StockRatios.ebitdaMargin` (−103.1%) and `evToEbitda`.
 *
 * The reconcile ALREADY knows: it offers `ebitdaRaw − exceptional` as a gate
 * translation covering 20.1% of surviving EBITDA disagreements. The gate was
 * compensating for a defect in the writer.
 *
 * ## Why it verifies the identity per filing instead of always subtracting
 *
 * Whether the disclosed number is signed (a charge tagged NEGATIVE, so PBT =
 * TI − TE + ex) or unsigned (a charge tagged POSITIVE and subtracted) is a
 * filer convention, and subtracting under the wrong one doubles the error
 * instead of removing it. So the filing has to prove its own convention on its
 * own numbers before anything is removed.
 *
 * Measured on prod 2026-08-22 over the 4,724 non-banking ANNUAL filings whose
 * exceptional item is MATERIAL (>1% of |PBT|, below which the two conventions
 * are indistinguishable): 4,697 satisfy the signed identity (99.4%), ZERO
 * satisfy the unsigned one, and 27 satisfy neither. This guard adjusts the
 * 4,697 and leaves the 27 exactly as they are — an as-reported number is a
 * defensible answer; a wrongly-adjusted one is not.
 *
 * Safe to change today: `source: "NSE_XBRL"` is 0 rows in BOTH
 * `stock_financials` and `stock_ratios` (verified 2026-08-22), so this costs no
 * migration. A week after arming it would be a backfill-and-explain exercise.
 */
/**
 * Mean of two balances — refused unless BOTH are positive (MONEY-1250).
 *
 * ## The guard that averaging broke, and how the test hid it
 *
 * `pct()` refuses a zero or negative denominator, so a negative-equity company
 * yielded NO roe. Averaging moved the guard's input out of its reach: OMAXE has
 * closing equity -196 cr against a prior +488 cr, so the MEAN is +146 cr —
 * positive, accepted, and a -468.79% roe reached the table. The company the
 * guard exists for walked straight through it.
 *
 * `pct` alone cannot catch this. By the time it sees +146 there is nothing wrong
 * with the number, so the refusal has to happen on the INPUTS.
 *
 * The regression test was updated alongside the averaging change and given a
 * prior carrying the SAME negative values — the mean stayed negative, the
 * assertion still passed, and it covered nothing. A FIXTURE can destroy a test's
 * coverage exactly as thoroughly as editing its assertion.
 *
 * 6 of 532 graded pairs on prod. AQYLON matches the VENDOR at -3,562%, so the
 * vendor publishes these too — this is fixed for the product, not for the gate.
 */
function mean(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a <= 0 || b <= 0) return undefined;
  const m = (a + b) / 2;
  return Number.isFinite(m) ? m : undefined;
}

/**
 * The newest annual period a vendor row computed at `fetchedAt` could describe
 * — MONEY-1250.
 *
 * ## The join this exists to replace
 *
 * `StockRatios` is `@@unique([symbol, exchange])` with NO period dimension, so
 * a row states a ratio and not the period it is a ratio OF. The gate joined OUR
 * newest annual filing to it on symbol alone, with no window check, and the
 * vendor rows are a frozen snapshot — 1,794 of 1,862 fetched 2026-03-21.
 *
 * Our newest annual, meanwhile, ranges FY2020 to FY2026. Comparing FY2026 to a
 * number computed in March 2026 is not a disagreement; it is two different
 * years. Measured, pinning every symbol to ONE year against the SAME vendor
 * values:
 *
 *     FY2024 -> 204 comparable, 10.8% match, 22 sign mismatches
 *     FY2025 -> 378 comparable, 40.2% match,  1 sign mismatch
 *     FY2026 -> 813 comparable,  9.1% match, 90 sign mismatches
 *
 * The sign COUNT is a function of the period chosen, which is the definition of
 * a join artifact rather than a data defect.
 *
 * ## The lag
 *
 * An Indian annual result is filed up to ~60 days after the fiscal year end
 * (SEBI LODR allows 60 for audited annual results), and a vendor needs it
 * published before it can compute a ratio. So a row computed on 2026-03-21
 * cannot describe FY2026 (ending 2026-03-31) and in practice describes FY2025.
 * `REPORTING_LAG_DAYS` is deliberately generous: an over-long lag picks the
 * PRIOR year, which is comparable-but-conservative, while too short picks a
 * year the vendor could not have seen and manufactures disagreements.
 */
export const VENDOR_REPORTING_LAG_DAYS = 75;

/**
 * The latest `periodEnd` a row computed at `fetchedAt` could be describing.
 * Returns `undefined` when the vendor row carries no date — in which case the
 * caller must NOT fall back to "newest", which is the bug.
 */
export function vendorComparablePeriodEnd(
  fetchedAt: Date | string | null | undefined,
  lagDays: number = VENDOR_REPORTING_LAG_DAYS,
): Date | undefined {
  if (fetchedAt === null || fetchedAt === undefined) return undefined;
  const t =
    fetchedAt instanceof Date ? fetchedAt.getTime() : Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t - lagDays * 86_400_000);
}

/**
 * Is `prior` the fiscal year IMMEDIATELY before `current`? — MONEY-1250.
 *
 * ## Why this has to be checked rather than assumed
 *
 * Callers supply the SECOND-NEWEST annual filing they hold, which is not the
 * same thing as the prior fiscal year. Measured on prod: only **59.7%** of
 * judged symbols with an FY2024-or-later winner also hold the adjacent year —
 * the rest have a gap, because a company delisted, re-listed, changed its
 * fiscal end, or simply never filed a year we could parse.
 *
 * Averaging a balance across a HOLE is not a smaller error than not averaging.
 * `(FY2026 + FY2023) / 2` is not an average equity for FY2026; it is a number
 * with no referent, and it lands in a published column with nothing saying so.
 * `assetTurnover` has carried this exposure unchecked since it was written.
 *
 * The tolerance is deliberately loose: fiscal years are 300-400 days here (the
 * repo's own span rule) and a 53-week year or a late filing must not read as a
 * gap. Anything under ~1.5 years apart is adjacent; a real gap is 2 years.
 */
export function isAdjacentAnnual(
  current: { period?: { end?: string }; basis?: string | null } | undefined,
  prior: { period?: { end?: string }; basis?: string | null } | undefined,
): boolean {
  // SAME BASIS, or there is nothing to average — MONEY-1250.
  //
  // `selectPeriodWinners` keys groups on `periodEnd|periodType|cumulative` with
  // NO basis, which is correct for picking ONE winner per period (consolidated
  // beats standalone). It means the two filings handed to `deriveRatios` can
  // legitimately be on DIFFERENT bases — a STANDALONE closing against a
  // CONSOLIDATED prior — and averaging those produces a denominator describing
  // no entity that exists. Measured: 29 of 532 graded pairs.
  //
  // It reached the table stamped `returnBasis: "AVERAGE"`, which asserted the
  // opposite of what happened: the stamp says "averaged over two comparable
  // balances" and they were not comparable.
  //
  // A null/absent basis on EITHER side is treated as unknown and refused, for
  // the same reason `tags` is optional rather than assumed: not-recorded is not
  // the same as matching.
  const basisA = current?.basis;
  const basisB = prior?.basis;
  if (
    basisA === null ||
    basisA === undefined ||
    basisB === null ||
    basisB === undefined ||
    basisA !== basisB
  ) {
    return false;
  }
  const a = current?.period?.end;
  const b = prior?.period?.end;
  if (a === undefined || b === undefined) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  const days = (ta - tb) / 86_400_000;
  // PRIOR must be older, and within one fiscal year plus slack.
  return days > 0 && days <= 550;
}

/**
 * Sum the parts that ARE present; `undefined` only when ALL are absent —
 * MONEY-1250.
 *
 * Deliberately NOT `sumAll`, which returns `undefined` if ANY part is missing.
 * That is the right rule when every part is required (an EBITDA missing its
 * depreciation is not an EBITDA), and the wrong one here: an NBFC with no
 * subordinated debt legitimately omits the element, and `sumAll` would delete
 * the `totalDebt` of every such filing.
 *
 * The "absent means zero" reading is MEASURED, not assumed. The Ind-AS funding
 * lines are additive children of the filing's own `FinancialLiabilities` total,
 * and 433 of 437 lender filings reconcile that identity to within 0.5%. Of the
 * 83 filings missing `DebtSecurities`, 81 leave a ~0 residual — genuinely nil —
 * and the 2 that do not are sub-Rs 1 Cr shells.
 */
function sumPresent(
  parts: ReadonlyArray<number | undefined>,
): number | undefined {
  const present = parts.filter((p): p is number => p !== undefined);
  if (present.length === 0) return undefined;
  const total = present.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? total : undefined;
}

/**
 * Which FILING SHAPE a lender used for its top line — MONEY-1250.
 *
 * ## The distinction the concept map erases
 *
 * `revenueFromOperations` accepts `RevenueFromOperations` OR `InterestEarned`,
 * so after parsing, a bank and an Ind-AS NBFC look identical in `values`. They
 * are NOT identical in the document. Measured on real filings 2026-08-22:
 *
 *     3MINDIA (Ind-AS mfg)   RevenueFromOperations present, InterestEarned ABSENT
 *     ICICIBANK (RBI Form-A) RevenueFromOperations ABSENT,  InterestEarned present
 *     360ONE (NBFC Ind-AS)   BOTH present, InterestEarned = 0.00
 *
 * ## Why the market convention differs between them
 *
 * For an RBI Form-A bank the reported top line IS interest earned: screener
 * shows ICICIBANK FY2025 "Revenue" 1,86,331 Cr with "Other Income" 1,08,255 Cr
 * on a SEPARATE line below. For an Ind-AS filer — including an NBFC that files
 * Division III — the convention is TOTAL income: 360ONE FY2024 consolidated
 * reports 2,921 on screener, which is `totalIncome` 2,924.73, not
 * `revenueFromOperations` 2,507.03.
 *
 * MONEY-1239 tried `isBank ? totalIncome : revenueFromOperations`, which fixes
 * 360ONE and breaks every true bank, and REVERTED it — correctly, because
 * `values` could not tell the shapes apart. `tags` can.
 *
 * Returns `undefined` when the filing predates tag capture (stored rows) or is
 * not a lender, so callers fall through to existing behaviour unchanged.
 *
 * ## INERT ON EVERY STORED FILING UNTIL A RE-PARSE — measured 2026-08-23
 *
 * `facts.tags` is present on **0 of 18,384** stored annual filings, because it
 * is written at PARSE time and every row predates it. So this function returns
 * `undefined` for all of them today and the top-line derivation is byte-identical
 * to what it was.
 *
 * That is the intended safety property, not a defect — no stored row changes
 * meaning retroactively — but it means the fix is DORMANT, not live. It takes
 * effect for filings parsed from here on, and for historical rows only after a
 * re-parse backfill. Do not read a gate run as evidence about this code path
 * until `tags` is populated.
 */
/**
 * Which BALANCE-SHEET form a filing was prepared on — MONEY-1250.
 *
 * ## Read this before using {@link lenderTopLineShape} for the same job
 *
 * That function returns the SAME two strings from a DIFFERENT discriminator —
 * `tags.revenueFromOperations === "InterestEarned"` — and the two disagree on
 * exactly the population this type exists to protect. An NBFC tags
 * `InterestEarned`, so `lenderTopLineShape` answers `"RBI_FORM_A"` for the 665
 * Ind-AS lender filings whose `totalDebt` the four-way sum was built to fill.
 * Substituting it here — which the shared vocabulary makes a one-line, entirely
 * plausible refactor — silently drops `totalDebt` and `totalCash` for all 665.
 *
 * They answer different questions. `lenderTopLineShape` is about the INCOME
 * statement's top line; this is about the BALANCE SHEET's structure. Keep them
 * apart.
 */
export type FilerShape = "RBI_FORM_A" | "IND_AS";

/**
 * THE single definition of the Form-A test — MONEY-1250 review.
 *
 * `bankCapital` is the measured discriminator: present on 76 of 76 RBI Form-A
 * filings and 0 of 871 Ind-AS lender filings. This existed as four separate
 * copies (the projection, the writer's provenance, and two sites in the
 * reconcile) under two subtly different definitions — `num(v, "bankCapital")`,
 * which rejects a non-finite value, versus a bare `!== undefined`, which
 * accepts one. With `bankCapital: NaN` the projection computed a totalDebt and
 * ownership dropped the column, so the value was silently never written. Safe
 * direction, but a live disagreement between the writer and the gate that
 * authorises it — which is the MONEY-1236 defect class.
 */
export function filerShapeOf(
  values: XbrlFinancials["values"] | undefined,
): FilerShape {
  const v = values?.bankCapital;
  return typeof v === "number" && Number.isFinite(v) ? "RBI_FORM_A" : "IND_AS";
}

export type LenderTopLineShape = "RBI_FORM_A" | "IND_AS";

export function lenderTopLineShape(
  f: Pick<XbrlFinancials, "family" | "tags">,
): LenderTopLineShape | undefined {
  if (!isLenderFamily(f.family)) return undefined;
  // `undefined` is "not recorded" (a row stored before MONEY-1250), NOT "no tag
  // matched". Guessing from `values` here is exactly the move that produced the
  // reverted fix, so an unrecorded filing keeps the old behaviour.
  const tag = f.tags?.revenueFromOperations;
  if (tag === undefined) return undefined;
  return tag === "InterestEarned" ? "RBI_FORM_A" : "IND_AS";
}

export function exceptionalAdjustment(
  v: Partial<Record<XbrlConcept, number>>,
): number {
  const ex = num(v, "exceptionalItems");
  if (ex === undefined || ex === 0) return 0;
  const ti = num(v, "totalIncome");
  const te = num(v, "totalExpenses");
  const pbt = num(v, "profitBeforeTax");
  if (ti === undefined || te === undefined || pbt === undefined) return 0;
  // The filing's own Schedule III identity, at the same tolerance the probe used.
  const tol = Math.max(1, Math.abs(pbt) * 1e-6);
  return Math.abs(ti - te + ex - pbt) <= tol ? ex : 0;
}

/**
 * `RatioInputs`, not `XbrlFinancials` — MONEY-1346. This function reads exactly
 * `values`, `family` and `basis`; every other field on a parsed filing is
 * provenance it never touches. Narrowing the parameter is what lets a
 * document-derived reading reach the same projection without inventing a
 * taxonomy, and `XbrlFinancials` stays assignable, so no call site moves.
 */
export function projectFinancials(f: RatioInputs): ProjectionResult {
  const v = f.values;
  const unfilled: ProjectionResult["unfilled"] = [];
  const note = (field: string, needed: XbrlConcept[]) =>
    unfilled.push({ field, needed });

  // A LENDER, not just a bank — see {@link isLenderFamily}.
  const isBank = isLenderFamily(f.family);

  // TOP LINE. For an RBI Form-A bank this resolves to `InterestEarned`, which
  // is the convention screener.in also reports (ICICIBANK FY2025 "Revenue"
  // 1,86,331 Cr with "Other Income" 1,08,255 Cr listed SEPARATELY below it).
  //
  // KNOWN DIVERGENCE, deliberately NOT "fixed" here — MONEY-1239. An Ind-AS
  // Division III financial that our classifier labels `banking` (it keys on a
  // `banking` schemaRef or an `InterestEarned`/`NameOfBank` tag) has a
  // different market convention: for 360ONE FY2024 consolidated, screener and
  // Tickertape both report the top line as 2,921 Cr, which is the filing's
  // `totalIncome` (2,924.73), not its `revenueFromOperations` (2,507.03).
  //
  // A blanket `isBank ? totalIncome : revenueFromOperations` was tried and
  // REVERTED: it fixes the 360ONE class and breaks every true bank, because
  // both filing shapes carry all three of revenueFromOperations/otherIncome/
  // totalIncome and the concept map folds `InterestEarned` INTO
  // `revenueFromOperations`, so `values` alone cannot tell the two shapes
  // apart. Splitting that tag out is the prerequisite, and it is a change to
  // the one-way-door write path that deserves more than one company's evidence.
  //
  // THE PREREQUISITE IS NOW MET — MONEY-1250. `tags` records which element
  // satisfied the concept, so the two shapes ARE distinguishable:
  //
  //   InterestEarned          -> RBI Form-A bank. Top line IS interest earned,
  //                              which is what the code already did and what
  //                              screener reports (ICICIBANK "Revenue"
  //                              1,86,331 with "Other Income" 1,08,255 SEPARATE).
  //   RevenueFromOperations   -> Ind-AS shape, INCLUDING an NBFC filing
  //                              Division III. Convention is TOTAL income
  //                              (360ONE FY2024: screener 2,921 = totalIncome
  //                              2,924.73, not revenueFromOperations 2,507.03).
  //
  // A lender whose filing predates tag capture returns `undefined` and keeps the
  // old behaviour exactly — no stored row changes meaning retroactively.
  const otherIncomeValue = num(v, "otherIncome");
  // THE SHAPE IS RECORDED, NOT ACTED ON — and that is a REVERSAL, MONEY-1250.
  //
  // This briefly read `shape === "IND_AS" ? totalIncome : revenueFromOperations`
  // on the strength of 360ONE, whose FY2024 CONSOLIDATED screener "Sales" of
  // 2,921 matches `totalIncome` 2,924.73 and not `revenueFromOperations`
  // 2,507.03. A second and third company REFUTE the rule:
  //
  //     IWEL       FY2025 STANDALONE  rev 16   oi 878  ti 895  -> screener 16
  //     WILLAMAGOR FY2026 STANDALONE  rev  2   oi 151  ti 153  -> screener  2
  //
  // Both are the SAME Ind-AS lender shape as 360ONE and both report Other
  // Income on a SEPARATE line, exactly as the code already does. So the top-line
  // convention is NOT a function of the filing shape, and switching on it would
  // have multiplied IWEL's revenue by 56x in a column whose unique key has no
  // `source`.
  //
  // Measured: 99 of 866 Ind-AS-shaped lender filings (11.4%) have other income
  // above 15% of revenue, i.e. the choice materially matters for ~100 rows and
  // the evidence for changing it is one company against two.
  //
  // `lenderTopLineShape` is kept because the DISTINCTION is real and the tag
  // does state it — it is simply not the thing that decides this. Whatever does
  // decide 360ONE's case is still unidentified, and MONEY-1239's DEFECT 2
  // remains open rather than fixed.
  const revenue = num(v, "revenueFromOperations");
  const profitBeforeTax = num(v, "profitBeforeTax");
  const financeCosts = num(v, "financeCosts");
  const depreciation = num(v, "depreciationAndAmortisation");

  // Prefer the owners' share on a consolidated filing: `profitForPeriod`
  // includes non-controlling interests, and reporting a subsidiary's minority
  // profit as the parent's earnings overstates EPS-adjacent figures for exactly
  // the companies where it matters most (holding structures).
  //
  // ## …but a tagged ZERO is not a reported zero — MONEY-1234
  //
  // 2,490 of 18,381 ANNUAL filings tag `ProfitOrLossAttributableToOwnersOfParent`
  // as LITERAL 0 beside a material `profitForPeriod`. The parser is not at fault:
  // `scanFacts` skips self-closing (nil) elements and `toFiniteNumber` rejects
  // empty text, precisely so a blank never becomes a zero. These filings really
  // do carry `0`. It is lazy tagging, and `??` cannot see it because 0 is a
  // perfectly good value.
  //
  // The tell is the accounting identity `attributable + nonControlling =
  // profitForPeriod`. Measured over those 2,490:
  //
  //     981    are STANDALONE      — minorities cannot exist, so attributable
  //                                  MUST equal profitForPeriod
  //     2,480  report NCI = 0      — "owners got 0" AND "minorities got 0" of a
  //                                  70 crore profit: arithmetically impossible
  //     6      omit NCI entirely   — same conclusion, nothing to attribute away
  //     4      report NCI ≈ profit — the ONLY shape where 0 is genuinely real
  //
  // So the zero is re-derived from the identity rather than overridden by a
  // magnitude threshold. That keeps those 4 zeros intact — a "|profit| >
  // epsilon, use the total" rule would have silently overwritten them. Left
  // unfixed this writes a 0 netIncome into `stock_financials`, which then feeds
  // netMargin, ROE and every screener rank.
  //
  // ON THOSE 4, READ THE CORRECTION BELOW FIRST — MONEY-1255. This census used
  // to call them "the ONLY shape where 0 is genuinely real" and "exactly the
  // wholly-minority-owned structures". The first three buckets are sound: they
  // are ARITHMETICALLY IMPOSSIBLE readings (0 + 0 cannot be 70 crore), and the
  // identity REJECTS them. The fourth is not the same kind of claim. `0 + pfp`
  // and `pfp + 0` both satisfy `att + nci = pfp`, so the identity is silent
  // about which line is which — the same symmetry the VADILALIND note further
  // down works through in full. What is true of these 4 is that the identity
  // does not CONVICT them, which is why re-deriving leaves them where they are;
  // it is not evidence that the tagged 0 is the owners' real share. Their
  // arbiter, if one is ever wanted, is the EPS check named in that note.
  // How close two magnitudes must be before a sign disagreement is read as a
  // TAGGING error rather than a real one. 2% absorbs the rounding that separates
  // HINDWAREAP's 68.01 from its 68.29 while staying far below any genuine
  // attribution split. MONEY-1237.
  const SIGN_MASK_TOLERANCE = 0.02;
  // SEPARATE CONSTANT, DELIBERATELY — MONEY-1250 review.
  //
  // Numerically equal to SIGN_MASK_TOLERANCE and must NOT be merged with it,
  // because the two express OPPOSITE claims about the same pair of numbers:
  //
  //   SIGN_MASK_TOLERANCE   "these two magnitudes are THE SAME number"
  //   LAZY_ZERO_TOLERANCE   "this magnitude is NEGLIGIBLE against that one"
  //
  // Sharing one knob couples them in the dangerous direction. Loosening the
  // sign-mask band to absorb more rounding — a benign-looking edit, and exactly
  // what its own docstring invites — would silently widen the lazy-zero band,
  // which RE-DERIVES values rather than merely re-signing them. At 5% that band
  // takes in 13 further prod rows that are real minority splits.
  const LAZY_ZERO_TOLERANCE = 0.02;
  const attributable = num(v, "profitAttributableToOwners");
  const profitForPeriod = num(v, "profitForPeriod");
  const nonControlling = num(v, "profitAttributableToNonControllingInterests");
  const impliedAttributable =
    profitForPeriod === undefined
      ? undefined
      : profitForPeriod - (nonControlling ?? 0);
  // No `impliedAttributable !== 0` clause: when the identity yields 0 it agrees
  // with the tagged 0, so both branches return the same value and the extra
  // condition is unreachable. Mutation testing caught it — deleting it changed
  // no test, which is the definition of dead logic rather than a missing case.
  // SIGN-MASKING, the sibling of the zero-masking above — MONEY-1237.
  //
  // Some filers tag `ProfitLossAttributableToOwnersOfParent` as a positive
  // MAGNITUDE for a loss and rely on the presentation layer's negated label to
  // render the minus. `profitForPeriod` on the very same filing carries the sign
  // correctly, so the contradiction is visible inside one document. Measured on
  // prod 2026-08-21 — every one of the five netIncome SIGN_MISMATCH cases the F3
  // reconcile reports has this exact shape:
  //
  //     INDIGO     FY2022  profitForPeriod -6,161.85 cr  attributable +6,161.85
  //     HINDWAREAP FY2025  profitForPeriod    -68.01 cr  attributable    +68.29
  //     IITL       FY2021 / KANORICHEM FY2023 / KRIDHANINF FY2024 — same shape
  //
  // INDIGO settles which side is right: InterGlobe Aviation lost ~6,162 crore in
  // FY2022. Preferring `attributable` writes a 6,162 crore PROFIT for the worst
  // year in the airline's history, into the one table with no `source` in its
  // key — and then feeds netMargin, ROE and every screener rank from it.
  //
  // The test is a SIGN DISAGREEMENT AT MATCHING MAGNITUDE, not "prefer the total"
  // and not a magnitude threshold. Both of those would damage the legitimate
  // cases: a real minority-heavy structure can have attributable and total
  // genuinely differ in size, and a real company can have them differ in sign
  // when non-controlling interests absorb the whole loss. Requiring the
  // magnitudes to agree within a few percent isolates the tagging error, which is
  // by construction the same number with the wrong sign.
  const signsDisagree =
    attributable !== undefined &&
    profitForPeriod !== undefined &&
    attributable * profitForPeriod < 0;
  // Compared against the IMPLIED attributable, not against the total — MONEY-1250.
  //
  // `profitForPeriod` is only the right reference when there are no minorities.
  // Where there are, the tagged value's counterpart is `pfp - nci`, and using the
  // total instead builds the whole minority share into the "disagreement":
  //
  //     KANORICHEM FY2023  pfp -12.88  att +8.73  nci -4.04
  //         implied  = -8.84   ->  |8.73| vs |8.84| is 1.2% apart, FIRES
  //         vs total = -12.88  ->  |8.73| vs |12.88| is 32% apart, refused
  //
  // Measured on prod 2026-08-24 over all 18,499 ANNUAL filings: 74 carry a sign
  // disagreement, the old reference fires on 14 and this one on 45, and NOTHING
  // is lost — the 31 gained are a strict superset.
  //
  // QUARTERLY MEASURED TOO — MONEY-1250 review, and not an afterthought: the
  // `createMissing` drain puts 73,875 quarterly filings through this same code,
  // and a rule sized only on ANNUAL is a rule sized on a fifth of its blast
  // radius. Over all 73,875: 287 sign disagreements, old reference fires on 24,
  // this one on 171, 147 gained, none lost. Proportionally the same population
  // (0.39% of filings vs 0.38% annual), so the drain introduces no new class —
  // it multiplies this one by roughly four.
  //
  // The widening is safe by construction rather than by tolerance. Both branches
  // re-derive THROUGH the identity, so wherever the identity holds the result is
  // the value already tagged and entering the branch changes nothing:
  //
  //     PDSL     att -7.84  nci +27.38  pfp +19.53  -> implied -7.84 == att, no-op
  //     APLLTD   att -1.08  nci +584.37 pfp +583.29 -> implied -1.08 == att, no-op
  //
  // Those are real wholly-minority-absorbed years, not tagging errors, and they
  // must stay untouched — which they do. The cases that MOVE are the ones where
  // the identity contradicts the tag's sign (KAYA +21.13 against an implied
  // -21.13; JPASSOCIAT +1,937.30 against -1,937.30), and there the identity is
  // the side backed by the other two numbers in the same document.
  //
  // EITHER reference, because there are two negated-label shapes and they are
  // not the same one:
  //
  //   (a) the owners' OWN number with the sign flipped   -> matches `implied`
  //   (b) the TOTAL's magnitude in the owners' slot      -> matches `pfp`
  //
  // (b) is what the `-100 / -30 / +100` fixture below pins, and it does not
  // occur in the current prod snapshot (`agreeOld && !agreeNew` measured ZERO) —
  // which is exactly why it must stay tested rather than be dropped as
  // unobserved. Both resolve to the same correction: re-derive through the
  // identity, so a genuine minority share is still attributed away.
  const magnitudeMatches = (reference: number | undefined): boolean =>
    reference !== undefined &&
    // Narrowed by an explicit guard rather than asserted with `!`: the
    // assertion was safe only under the `signsDisagree &&` short-circuit, so
    // reordering the operands would have reintroduced the risk silently.
    attributable !== undefined &&
    Math.abs(Math.abs(attributable) - Math.abs(reference)) <=
      Math.abs(reference) * SIGN_MASK_TOLERANCE;
  const magnitudesAgree =
    signsDisagree &&
    (magnitudeMatches(impliedAttributable) ||
      magnitudeMatches(profitForPeriod));

  // ── THE THIRD NEGATED-LABEL SHAPE: BOTH attribution lines negated ──
  //
  // MONEY-1250 (T3.3). Shapes (a) and (b) above both assume the filer negated
  // the OWNERS' line and got the minority line right. A third exists and is
  // measured: some filers tag BOTH attribution elements as unsigned MAGNITUDES
  // of a loss, and rely on the presentation layer's negated labels to render
  // two minus signs. `profitForPeriod` on the same document carries the sign
  // correctly, so the contradiction is again visible inside one filing:
  //
  //     IITL FY2021 CONSOLIDATED
  //       profitAttributableToOwners                    +419,447,000
  //       profitAttributableToNonControllingInterests    +47,097,000
  //       profitForPeriod                              -467,863,000
  //       |owners| + |nci| = 466,544,000  vs  |pfp| = 467,863,000  (0.28%)
  //
  // and the filing's own roll-up lines agree with the TOTAL's sign to the rupee
  // (`profitFromContinuingOperations -14,085,000 + shareOfProfitOfAssociates
  // -453,778,000 = -467,863,000`), so it is the attribution pair that is wrong.
  //
  // The existing mask cannot see it. It compares `|attributable|` against
  // `|pfp - nci|`, and with the NCI itself sign-flipped that reference is
  // wrong by 2·nci — IITL's implied is -514,960,000 against a tagged
  // +419,447,000, 22.7% apart, so the mask refuses and the projection writes a
  // +41.94 crore PROFIT for a year the company lost 42 crore. It is the last
  // netIncome SIGN_MISMATCH the F3 reconcile reports.
  //
  // ## The test: the SUM of both lines, against the total
  //
  // The identity is `owners + nci = pfp`. Under this shape the tagged pair sums
  // to `-pfp`, so the signature is a sign disagreement between `att + nci` and
  // `pfp` AT MATCHING MAGNITUDE — the same claim the owners-only mask makes,
  // moved to the pair.
  //
  // ## Why this cannot fire on a healthy filing — MONEY-1250
  //
  // Structural, not tolerance-dependent. If a filing's own identity holds then
  // `att + nci === pfp`, so `(att + nci) * pfp === pfp² > 0` and the sign test
  // is false before any magnitude is compared. The rule is therefore reachable
  // ONLY by filings that already contradict themselves. That is what makes it
  // safe to widen a sign correction on a table whose unique key has no
  // `source`, and it is a stronger guarantee than the owners-only mask has:
  // that one CAN fire on a self-consistent filing where nci absorbs the whole
  // loss, which is precisely why it needs its 2% band.
  //
  // ## Census, prod 2026-08-26, all 96,063 filings (39,309 consolidated)
  //
  //   consolidated filings matching the signature      19 ANNUAL, 31 QUARTERLY
  //   already handled by the owners-only mask          13 ANNUAL, 21 QUARTERLY
  //   NEWLY corrected by this branch                    6 ANNUAL, 10 QUARTERLY
  //
  // The six annual ones are ASHOKA FY2018, IITL FY2021, PROVOGE FY2018,
  // PUNJLLOYD FY2018, SADBHIN FY2018 and WIPL FY2021.
  //
  // ## The whole-population diff, because a census is not a blast radius
  //
  // Replaying the OLD formula and the new one over every one of the 96,063
  // stored filings: netIncome changes on 27 (10 ANNUAL, 17 QUARTERLY). Sixteen
  // are the sign flips above; the other eleven are the tie-break below moving a
  // value whose sign was already right by 0.001%–1.7%. Every one of the 27 was
  // then checked against a THIRD, independent figure the filing states itself —
  // `basicEps × (paidUpEquityShareCapital / faceValuePerShare)`, which under
  // Ind-AS 33 is the profit attributable to OWNERS and so is not derivable from
  // the three tags this rule reads. The new value is closer to it in every case
  // where the filing states a usable EPS. Examples:
  //
  //     SELMCL   FY2018  -25,279,195,000 -> -25,274,833,000  (EPS -25,275,149,160)
  //     AJRINFRA Q1FY23  -13,573,887,000 -> -13,388,581,000  (EPS -13,450,442,040)
  //     FLEXITUFF Q3FY20    -859,865,000 ->    -854,669,000  (EPS    -854,724,180)
  //
  // ## The one STANDALONE case, written down rather than rounded off
  //
  // This paragraph used to claim standalone filings could not reach here, on
  // the reasoning that an entity with no subsidiaries has no second line to
  // negate. The population disagrees: KOTARISUG Q4-FY2018 is STANDALONE and
  // tags a non-controlling interest anyway (att +35,195,000, nci +12,703,000,
  // pfp -47,897,000). Its `att + nci` matches `|pfp|` to 0.002%, so the rule
  // fires and moves netIncome from +35,195,000 to -35,194,000 — while its EPS
  // implies -46,417,616, i.e. the corrected value has the right SIGN and is
  // still ~24% light.
  //
  // Kept, deliberately, and not "fixed" by zeroing the NCI on standalone
  // filings the way `attributableIsLazyNearZero` does. Measured: that variant
  // stops the rule firing on this filing at all and leaves the incumbent
  // +35,195,000 — a POSITIVE net income for a quarter the company lost money,
  // feeding netMargin, ROE and every screener rank. A sign that is right and a
  // magnitude that is 24% light beats a sign that is wrong.
  const attributionPairSum =
    attributable !== undefined && profitForPeriod !== undefined
      ? attributable + (nonControlling ?? 0)
      : undefined;
  const pairSignDisagrees =
    attributionPairSum !== undefined &&
    profitForPeriod !== undefined &&
    attributionPairSum * profitForPeriod < 0;
  // SIGN_MASK_TOLERANCE, not the 5% the census was drawn at. The band states
  // "these two magnitudes are THE SAME number", which is the identical claim
  // the owners-only mask makes, so it takes the identical constant — and
  // measured, the two bands select the SAME rows: every one of the 16 newly
  // corrected filings sits at <=0.28% and widening 2% -> 5% adds exactly ZERO.
  // A looser band would therefore buy nothing and would only reduce the margin
  // between this shape and a genuine near-breakeven attribution split.
  const pairMagnitudesAgree =
    pairSignDisagrees &&
    attributionPairSum !== undefined &&
    profitForPeriod !== undefined &&
    Math.abs(Math.abs(attributionPairSum) - Math.abs(profitForPeriod)) <=
      Math.abs(profitForPeriod) * SIGN_MASK_TOLERANCE;
  // Re-derived THROUGH THE IDENTITY, exactly as the other two branches are, and
  // anchored on the TOTAL for the reason stated there: no attribution
  // convention can flip a total's sign. What differs is that the minority line
  // is negated too, so the term removed is `-nonControlling`:
  //
  //     owners = pfp - (-nci) = pfp + nci
  //     IITL:  -467,863,000 + 47,097,000 = -420,766,000  (-42.0766 crore,
  //            0.09% from the vendor's -42.04)
  //
  // NOT `-attributable`. The two agree to the rupee wherever the identity is
  // exact (ASHOKA, PROVOGE, PUNJLLOYD and WIPL all land on `-att` exactly), and
  // where they differ the total is the side backed by the rest of the document.
  const bothLinesNegatedAttributable =
    profitForPeriod === undefined
      ? undefined
      : profitForPeriod + (nonControlling ?? 0);
  // ── The tie-break, and it had to be MEASURED rather than assumed ──
  //
  // Both masks can fire on one filing, and the first draft of this change
  // simply ordered the new branch second on the assumption that the incumbent
  // reading would be the exact one. Measured over every consolidated filing
  // with a non-zero NCI where both fire (17 rows), that assumption is wrong in
  // 10 of them: the owners-only reading leaves an identity residual of
  // 0.016%–2.5% while the both-negated reading closes to 0.000%. SOMATEX
  // FY2018, SELMCL FY2018, ALCHEM FY2018, ISMTLTD FY2018, AJRINFRA Q1-FY2023
  // and PVRINOX Q1-FY2026 are all in that set.
  //
  // The other 5 go the other way and are just as real — HINDWAREAP FY2025
  // (att +682.9m, nci +2.8m, pfp -680.1m) is exact under owners-only and 0.82%
  // off under both-negated — so neither fixed order is right. Pick the reading
  // that satisfies the filing's OWN identity more closely; positional
  // precedence is what a tie-break looks like when nobody measured it.
  // Scored on the READING — what each hypothesis claims the two tags MEAN —
  // never on the value the branch would emit. Both branches re-derive the
  // owners' share from the total, so both outputs satisfy `owners + nci = pfp`
  // by construction and both would score a residual of exactly zero. That is a
  // tautology, not evidence, and it is the trap this comment exists to mark.
  const readingResidual = (
    ownersSign: 1 | -1,
    nciSign: 1 | -1,
  ): number | undefined =>
    attributable === undefined || profitForPeriod === undefined
      ? undefined
      : Math.abs(
          ownersSign * attributable +
            nciSign * (nonControlling ?? 0) -
            profitForPeriod,
        );
  /** Shape (a)/(b): the OWNERS' line is negated, the minority line is not. */
  const ownersOnlyResidual = readingResidual(-1, 1);
  /** Shape (c): BOTH lines are unsigned magnitudes of the same loss. */
  const bothNegatedResidual = readingResidual(-1, -1);
  const bothLinesNegated =
    pairMagnitudesAgree &&
    bothLinesNegatedAttributable !== undefined &&
    (!magnitudesAgree ||
      (bothNegatedResidual !== undefined &&
        ownersOnlyResidual !== undefined &&
        bothNegatedResidual < ownersOnlyResidual));

  // The exact-zero test above misses a LAZY NEAR-ZERO — MONEY-1250. DHANUKA
  // tags `attributable` as 1,00,00,000 against a `profitForPeriod` of
  // 1,26,17,77,000 and an NCI of 0: the identity says the owners took the whole
  // 126 crore, and the filing claims 1. `=== 0` cannot see it, so the projection
  // writes a 126x understatement into netMargin and ROE.
  //
  // Measured on prod 2026-08-24 over all 18,499 ANNUAL filings, the band
  // `0 < |attributable| <= 2%|profitForPeriod|` holds just 26 rows, and — unlike
  // the exact-zero population, which was 2,486 defects against 4 legitimate —
  // they do NOT share one shape:
  //
  //     9  NCI = 0            lazy tag; the identity gives the whole profit
  //     3  STANDALONE         no minorities can exist
  //     1  NCI absent         same conclusion
  //     6  NCI ~= profit      the identity closes and says nothing about WHICH
  //                           line is which. VADILALIND FY: att -47,000 + nci
  //                           41,38,35,000 = pfp 41,37,88,000 to the rupee. See
  //                           the correction below — this row is very probably
  //                           a SWAP, not a minority-owned structure.
  //     7  identity broken    COFFEEDAY att -2,40,00,000 + nci -1,00,00,000 is
  //                           -3,40,00,000 against a pfp of 1,48,30,00,000. The
  //                           document contradicts itself and re-deriving would
  //                           assert a number nothing in it supports
  //
  // So the widening is gated on NCI being ZERO OR ABSENT, which is the only
  // sub-population where the identity has one reading. That is a no-op for the 6
  // legitimate rows (their NCI is large) and declines the 7 broken ones outright
  // rather than guessing. ~12 rows move. `stock_financials` has no `source` in
  // its unique key, so every one of these writes is a one-way door; a rule that
  // is right about 13 rows and arbitrary about 7 is not worth walking through it.
  //
  // QUARTERLY, measured on the same day for the same reason: the band holds 81
  // of 73,875 filings, the rule fires on 29 and the basis guard declines 1 —
  // 0.11% of filings against ANNUAL's 0.13%. Same shape, four times the volume.
  //
  // ## CORRECTION — "the identity CONFIRMS the tiny value" was FALSE (MONEY-1255)
  //
  // That sentence stood above VADILALIND for two tickets and it does not
  // survive being written out. The identity is
  //
  //     attributable + nonControlling = profitForPeriod
  //
  // and ADDITION IS COMMUTATIVE, so it is SYMMETRIC under swapping the two
  // addends. Measured on this exact row rather than argued:
  //
  //     as filed   att    -47,000 + nci 413,835,000 = 413,788,000 = pfp  EXACT
  //     swapped    att 413,835,000 + nci     -47,000 = 413,788,000 = pfp  EXACT
  //
  // Both readings close to the rupee. An identity that both hypotheses satisfy
  // discriminates between neither — it can only ever reject the pair that
  // BREAKS it (COFFEEDAY, the row below), never elect one of two that keep it.
  // Calling it confirmation was the same tautology this file already flags one
  // screen up, where `readingResidual` is scored on the READING precisely
  // because scoring it on the emitted value "would score a residual of exactly
  // zero. That is a tautology, not evidence." The trap was marked and then
  // walked into anyway, four census lines later.
  //
  // ## What DOES discriminate: the filing's own EPS
  //
  // `basicEps x (paidUpEquityShareCapital / faceValuePerShare)` is the profit
  // attributable to OWNERS under Ind-AS 33, and it is not derivable from the
  // three tags this rule reads — which is exactly why the `bothLinesNegated`
  // census above uses it as the arbiter (SELMCL, AJRINFRA, FLEXITUFF). Applied
  // here it lands on the 41.38 crore side, not the -47,000 side: the two
  // hypotheses imply per-share figures three to four orders of magnitude apart
  // on the same share count, so this is not a close call the tolerance could
  // swallow. The tags are SWAPPED — the owners took the 41.38 crore and the
  // minority line is the -47,000.
  //
  // ## What the code does about it: NOTHING, on purpose
  //
  // Traced and measured, not inferred. `attributableIsLazyNearZero` declines
  // (its NCI gate requires `nonControlling === 0`, and here it is 41.38 crore);
  // `bothLinesNegated` declines (`att + nci` equals `pfp` including its sign,
  // so `pairSignDisagrees` is false); `magnitudesAgree` then fires and
  // re-derives `pfp - nci`, which is -47,000 again. Net result:
  // `netIncome = -47,000`, i.e. the filing's tags at face value.
  //
  // That is deliberate and is NOT being changed here. A swap-detector keyed on
  // EPS is a different rule with a different blast radius, and it would have to
  // be measured over the whole population before it touched a table whose
  // `@@unique` carries no `source`. What is fixed is the CLAIM: this row is a
  // suspected mis-tag we currently pass through, not a confirmed reading. It
  // needs its own ticket, an EPS-arbitrated census of the whole 2%-band
  // population, and the same whole-population replay diff the branch above got.
  // The 41.38 crore is the number a reader would expect to see; -47,000 is what
  // `stock_financials`, `netMargin` and `roe` will carry until then.
  const attributableIsLazyNearZero =
    attributable !== undefined &&
    attributable !== 0 &&
    profitForPeriod !== undefined &&
    profitForPeriod !== 0 &&
    Math.abs(attributable) <= Math.abs(profitForPeriod) * LAZY_ZERO_TOLERANCE &&
    // The whole safety of this rule. Without it the 7 self-contradicting
    // filings above get an invented value.
    //
    // "NCI ABSENT" IS NOT "NCI IS ZERO" — MONEY-1250 review. Where the element
    // is missing the identity `att + nci = pfp` cannot be evaluated at all, and
    // treating absence as zero takes the identity's word for a term the document
    // never supplies. The 26-row census called that shape "nothing to attribute
    // away"; that inference IS the defect. Measured:
    //
    //     att 2cr, pfp 100cr, nci ABSENT  -> would write 100, a 50x overstatement
    //     att 2cr, pfp 100cr, nci 98cr    -> correctly declines
    //
    // and this dataset contains the shape: IITL FY2021 carries an untagged
    // minority interest (owners -41.94, total -46.79, no NCI element).
    //
    // `basis` answers what the element cannot. A STANDALONE filing has no
    // subsidiaries, so minorities cannot exist and an absent NCI really does
    // mean zero. On a CONSOLIDATED filing an absent NCI means UNKNOWN, and
    // unknown must not resolve to the permissive value in front of a one-way
    // door. Keeps all 13 intended rows (9 nci=0, 3 standalone, 1 declined).
    (nonControlling === 0 ||
      (nonControlling === undefined && f.basis === "standalone"));

  const netIncome =
    (attributable === 0 || attributableIsLazyNearZero) &&
    impliedAttributable !== undefined
      ? impliedAttributable
      : // MONEY-1250 (T3.3) — the both-lines-negated shape. Placed here rather
        // than after `magnitudesAgree` because `bothLinesNegated` already
        // carries the tie-break: where both masks fire it is true only when the
        // filing's own identity prefers this reading, so the position is not
        // what decides the outcome. Positional precedence WAS the first draft,
        // and measurement said it is wrong in 10 of the 17 overlapping rows.
        bothLinesNegated && bothLinesNegatedAttributable !== undefined
        ? bothLinesNegatedAttributable
        : magnitudesAgree
          ? // The filing contradicts itself and only one side can be trusted:
            // `profitForPeriod` is a total, so no attribution convention can flip
            // its sign, while the attributable element is the one carrying a
            // negated label. Re-derive through the identity so a genuine minority
            // share is still removed rather than silently folded into the owners'.
            (impliedAttributable ?? profitForPeriod)
          : (attributable ?? profitForPeriod);

  // EXCEPTIONAL ITEMS ARE REMOVED — MONEY-1239. See `exceptionalAdjustment`
  // for the evidence and for why the filing must prove its own sign convention
  // before anything is subtracted. `sumAll` still refuses on a missing part, so
  // an absent exceptional line simply adjusts by 0 rather than voiding EBITDA.
  const ebitdaRaw = isBank
    ? undefined
    : sumAll([profitBeforeTax, financeCosts, depreciation]);
  const ebitda =
    ebitdaRaw === undefined
      ? // Same fallback rule as `operatingIncome` above, and refused for a
        // lender for the same reason the components route is: interest expended
        // IS a bank's cost of goods, so an EBITDA for one has no meaning
        // whoever computed it.
        isBank
        ? undefined
        : finite(f.reportedIncome?.ebitdaBeforeExceptionalItems)
      : ebitdaRaw - exceptionalAdjustment(v);
  if (ebitda === undefined && !isBank) {
    // The COLUMN name, not the local — `unfilled` is stored on the row and read
    // by anyone asking "why is this cell empty", so it has to name the cell.
    note("ebitdaBeforeExceptionalItems", [
      "profitBeforeTax",
      "financeCosts",
      "depreciationAndAmortisation",
    ]);
  }

  // Operating income = revenue less operating expenses, AFTER depreciation.
  //
  // Filings disclose `totalExpenses` INCLUSIVE of finance costs and
  // depreciation. Only finance costs are added back: interest is a FINANCING
  // charge and does not belong in an operating figure, whereas depreciation is
  // an operating cost of using the assets that produced the revenue.
  //
  // ## What this used to be, and why it was wrong — MONEY-1234
  //
  // The formula also added `+ (depreciation ?? 0)`, which made this an
  // operating EBITDA wearing operating income's name. Three consequences, none
  // of them visible from inside this function:
  //
  //  1. It nearly DUPLICATED `ebitda` above. `ebitda = PBT + FC + Dep` and the
  //     old `operatingIncome = Rev − TotalExp + FC + Dep` differ only by
  //     whatever sits between `totalExpenses` and PBT — on GLAXO that is
  //     `otherIncome` alone (3,558.3mn vs 3,189.5mn). Two columns, one number.
  //  2. `deriveRatios` does not recompute the margin — it reads this value
  //     (`pct(inc?.operatingIncome, inc?.revenue)`), so every stored
  //     `StockRatios.operatingMargin` was an EBITDA margin under an EBIT name,
  //     and the "High Margin Moats" screener preset ranked on it.
  //  3. `input-bindings.ts` binds this field to the `ebit` parameter of the
  //     Altman Z-score. It was feeding an EBITDA into a slot named EBIT.
  //
  // The vendor we reconcile against agrees with the corrected definition, and
  // that is measured rather than assumed: `tickertape-statement-mapper.test.ts`
  // asserts `incEbi − incDep = incPbi` across every captured fixture, i.e.
  // their `operatingIncome` is EBIT after depreciation. Ours was above theirs by
  // the entire depreciation line — outside the reconcile's 1% tolerance for any
  // capital-intensive filer.
  //
  // Changed BEFORE the first armed write: `source: "NSE_XBRL"` is 0 rows, so
  // this costs no migration today and would be a backfill-and-explain exercise a
  // week from now.
  //
  // NOTE this remains EBIT EXCLUDING other income (which sits above PBT but
  // below `totalExpenses`), while the vendor's `incPbi` includes it. That
  // residual gap is a definitional one and is handled by the gate's translated
  // comparison, not by moving non-operating income into an operating figure.
  const totalExpenses = num(v, "totalExpenses");
  const derivedOperatingIncome = isBank
    ? num(v, "operatingProfitBeforeProvisions")
    : revenue !== undefined && totalExpenses !== undefined
      ? revenue - totalExpenses + (financeCosts ?? 0)
      : undefined;
  // FALLBACK ONLY, and unreachable for an XBRL filing — MONEY-1346. See
  // `ReportedIncomeLines`: an Indian filing publishes no operating-profit
  // concept, so this is derived from components; a document READING is asked
  // for the line the statement prints and is not asked for `totalExpenses`.
  // The derivation still WINS whenever it produced anything, so the branch
  // cannot change what any existing caller gets.
  const operatingIncome =
    derivedOperatingIncome ??
    finite(f.reportedIncome?.operatingIncomeExOtherIncome);
  if (operatingIncome === undefined) {
    note(
      "operatingIncomeExOtherIncome",
      isBank
        ? ["operatingProfitBeforeProvisions"]
        : ["revenueFromOperations", "totalExpenses"],
    );
  }

  if (revenue === undefined) {
    note("revenueFromOperations", ["revenueFromOperations"]);
  }
  if (netIncome === undefined) {
    note("netIncome", ["profitAttributableToOwners", "profitForPeriod"]);
  }

  const income: ProjectedFinancials | null =
    revenue === undefined &&
    netIncome === undefined &&
    operatingIncome === undefined &&
    ebitda === undefined
      ? null
      : {
          statementType: "INCOME",
          // The COLUMN is `revenueFromOperations` — MONEY-1255. `revenue` is
          // the vendor's TOTAL INCOME column and this projection no longer
          // claims it; see `UNOWNED_VENDOR_COLUMNS`.
          ...(revenue !== undefined ? { revenueFromOperations: revenue } : {}),
          // DISCLOSED, not derived — MONEY-1250. Read straight off the filing's
          // own `OtherIncome` element; nothing is computed, so there is no
          // convention to get wrong. This is the component that makes the
          // operations-vs-total EBITDA choice reversible.
          //
          // Written for lenders TOO: unlike `operatingIncome` and `ebitda`,
          // which a lender cannot source and therefore does not own, other
          // income is disclosed by every filing shape we carry (ICICIBANK
          // FY2025 reports it at 1,08,255 Cr on its own line).
          ...(otherIncomeValue !== undefined
            ? { otherIncome: otherIncomeValue }
            : {}),
          ...(operatingIncome !== undefined
            ? { operatingIncomeExOtherIncome: operatingIncome }
            : {}),
          ...(netIncome !== undefined ? { netIncome } : {}),
          ...(ebitda !== undefined
            ? { ebitdaBeforeExceptionalItems: ebitda }
            : {}),
        };

  // ── Balance sheet ──
  const totalAssets = num(v, "totalAssets");

  // The ordinary (non-lender) routes, named once so the lender branches can FALL
  // BACK to them instead of ending at a dead end — MONEY-1234.
  const genericEquity =
    num(v, "totalEquity") ??
    sumAll([num(v, "equityShareCapital"), num(v, "otherEquity")]);
  const genericDebt =
    sumAll([num(v, "borrowingsCurrent"), num(v, "borrowingsNonCurrent")]) ??
    num(v, "borrowingsNonCurrent") ??
    num(v, "borrowingsCurrent");

  // A bank's equity is Capital + Reserves, which the XBRL discloses separately
  // and never as a total. Summed here rather than in the parser because summing
  // is DERIVATION, and the parser's contract is to report what the filing said.
  //
  // ## …but the lender branch must not be a DEAD END — MONEY-1234
  //
  // This used to be `isBank ? sumAll([bankCapital, bankReserves]) : generic`,
  // with no fallback. `family` is set by taxonomy/tag evidence, so an NBFC that
  // files in ordinary Ind-AS format is classified `nbfc` while carrying none of
  // the banking tags — and its equity was then thrown away even though the
  // filing states it outright.
  //
  // Measured on prod 2026-08-21: of 946 lender-family ANNUAL filings, 438
  // disclose `totalEquity`, and the projection lost it on 438 of 438. That takes
  // `roe` and `debtToEquity` with it. BAJAJHLDNG FY2025 is the worked example —
  // `totalEquity` 726,690,600,000 present in the facts, `undefined` out of the
  // projection, `roe` gone.
  //
  // The bank-specific sum still WINS when present; it is only the failure case
  // that changed, from "give up" to "use what the filing actually says".
  const totalEquity = isBank
    ? (sumAll([num(v, "bankCapital"), num(v, "bankReservesAndSurplus")]) ??
      genericEquity)
    : genericEquity;

  // Same shape, same reason: a lender whose filing omits the aggregate
  // `borrowings` tag but splits current/non-current should not lose its debt.
  // TWO LENDER SHAPES, OPPOSITE ANSWERS — MONEY-1250.
  //
  // Branch on the FILING SHAPE, never on `family`: `family` is "banking" for
  // 665 NBFC documents (an NBFC tags `InterestEarned`, which is what the
  // classifier keys on). `bankCapital` is the measured discriminator — present
  // on 76 of 76 RBI Form-A filings and 0 of 871 Ind-AS lender filings.
  //
  // IND-AS LENDER: funding is split across FOUR elements and `Borrowings` alone
  // is a median 45% of the total. Against the incumbent on 135 Ind-AS-shape
  // company-years, `Borrowings` alone agrees within 1% on 21; the four-way sum
  // on 100. Above Rs 10,000 Cr of debt: 0 of 43 versus 37 of 43. Third-sourced
  // to 0.00% on BAJFINANCE (FY2024/25/26), SHRIRAMFIN, CHOLAFIN, MUTHOOTFIN.
  //
  // RBI FORM-A BANK: `totalDebt` is NOT OWNED. Not because we cannot source it —
  // `Borrowings` alone reproduces screener exactly for HDFCBANK and AXISBANK —
  // but because the number is a leverage claim nobody makes. Deposits are a
  // bank's franchise, not its gearing; Indian bank analysis uses CAR/CET1, and
  // the incumbent publishes NO `totalDebt` for a bank on 35 of 35 comparable
  // rows (Tickertape leaves `balTdeb` null and populates `balTdep` instead).
  // Publishing D/E 1.51 for HDFCBANK into a column whose honest incumbent is
  // null is the "prefer not-claiming over compensating" case exactly.
  const isFormABank = filerShapeOf(v) === "RBI_FORM_A";
  const totalDebt = isFormABank
    ? undefined
    : isBank
      ? (sumPresent([
          num(v, "borrowings"),
          num(v, "debtSecurities"),
          num(v, "deposits"),
          num(v, "subordinatedLiabilities"),
        ]) ?? genericDebt)
      : genericDebt;

  // THREE LINES, NOT ONE — MONEY-1250.
  //
  // `CashAndCashEquivalents` alone disagreed with the incumbent on 85.8% of
  // 2,437 comparable pairs, 99.4% of it in one direction, median `ours/theirs`
  // 0.267 — we published roughly a quarter of the cash a company holds. The
  // market's figure adds short-term bank balances and current investments:
  // 28 of 29 sampled filings fit the three-way sum exactly (RELIANCE
  // 1,06,502 -> 2,25,211, WIPRO 12,197 -> 53,345, TCS 8,342 -> 46,152) and 0 of
  // 29 fit cash alone.
  //
  // `sumPresent`, so an absent part contributes nothing instead of voiding the
  // total: a company with no deposits and no current investments legitimately
  // files neither line, and its `totalCash` is still its cash.
  //
  // DORMANT UNTIL RE-PARSE, and that is not a caveat to discover later: the two
  // concepts did not exist in the registry, so none of the 19,447 stored ANNUAL
  // filings carry them. Every stored row keeps exactly today's value and the
  // gate will keep reporting 85.8% until the filings are re-ingested. What this
  // changes is what a NEWLY parsed filing means. Same shape as `tags`.
  //
  // A Form-A bank is unaffected either way — it owns no `totalCash` at all
  // (0 of 84 carry any cash concept; see `writableFields`).
  const totalCash = sumPresent([
    num(v, "cashAndCashEquivalents"),
    num(v, "bankBalanceOther"),
    num(v, "currentInvestments"),
  ]);
  const totalLiabilities =
    num(v, "totalLiabilities") ??
    (totalAssets !== undefined && totalEquity !== undefined
      ? totalAssets - totalEquity
      : undefined);

  if (totalAssets === undefined) note("totalAssets", ["totalAssets"]);
  if (totalEquity === undefined) {
    note(
      "totalEquity",
      isBank
        ? ["bankCapital", "bankReservesAndSurplus"]
        : ["totalEquity", "equityShareCapital", "otherEquity"],
    );
  }

  const balanceSheet: ProjectedFinancials | null =
    totalAssets === undefined &&
    totalEquity === undefined &&
    totalDebt === undefined &&
    totalCash === undefined
      ? null
      : {
          statementType: "BALANCE_SHEET",
          ...(totalAssets !== undefined ? { totalAssets } : {}),
          ...(totalLiabilities !== undefined ? { totalLiabilities } : {}),
          ...(totalEquity !== undefined ? { totalEquity } : {}),
          ...(totalDebt !== undefined ? { totalDebt } : {}),
          ...(totalCash !== undefined ? { totalCash } : {}),
        };

  return { income, balanceSheet, unfilled };
}

// ─── Ratios ──────────────────────────────────────────────────────────

export interface DerivedRatios {
  netMargin?: number;
  operatingMargin?: number;
  /**
   * MONEY-1115 — EBITDA margin. Derived as
   * `(PBT + financeCosts + depreciationAndAmortisation) / revenue`, which is
   * the only route available: the taxonomy has no EBITDA concept, and starting
   * from `profitForPeriod` instead of PBT would subtract tax and make this a
   * post-tax margin wearing a pre-tax name.
   *
   * NOTE there is deliberately NO `grossMargin`. Gross margin needs cost of
   * goods sold, and NO XBRL concept in `XbrlConcept` carries it — the closest,
   * `totalExpenses`, includes finance costs, depreciation and employee benefit
   * expense, so `1 - totalExpenses/revenue` is an operating margin with a
   * different name. `StockRatios.grossMargin` therefore stays whatever
   * Tickertape supplied; the XBRL producer must leave that column alone rather
   * than fill it with a lookalike.
   */
  ebitdaMargin?: number;
  roe?: number;
  roa?: number;
  /**
   * WHICH DENOMINATOR `roe` and `roa` were computed over — MONEY-1250.
   *
   * `AVERAGE` — `(closing + prior closing) / 2`, the convention the vendor uses
   *             and the one a flow-over-stock ratio wants. Requires an ADJACENT
   *             prior annual filing.
   * `CLOSING` — the point-in-time balance, used when no adjacent prior exists.
   *             Legitimate and widely published, but it OVERSTATES the return of
   *             any company whose equity grew during the period.
   *
   * Stored rather than chosen, because both answers are defensible and the
   * column is compared against a vendor that uses exactly one of them. Measured
   * on prod: CLOSING matches the vendor 45.3% of the time, AVERAGE 89.5% (92.5%
   * consolidated) — so a gate that cannot tell them apart is judging a mixture
   * and blaming the data.
   *
   * Coverage, measured 2026-08-23 over 2,353 symbols with annual filings:
   * 1,508 (64.1%) have an adjacent prior and get AVERAGE; 845 (35.9%) do not
   * and get CLOSING. Refusing that 35.9% was considered and rejected — some of
   * those symbols hold only three filing-derived ratios in total, so dropping
   * two would take them under `isPlanWorthWriting`'s floor and cost them their
   * whole row.
   *
   * `undefined` when neither ratio was derived at all.
   */
  returnBasis?: "AVERAGE" | "CLOSING";
  /**
   * Return on capital employed — `EBIT / (totalEquity + total borrowings)`.
   * EBIT is `PBT + financeCosts`: interest is added back because the
   * denominator includes the debt that produced it.
   */
  roce?: number;
  debtToEquity?: number;
  /**
   * `EBIT / financeCosts`. Refused when finance costs are zero — a company with
   * no interest expense has *undefined* coverage, not infinite coverage, and an
   * Infinity here sorts to the top of every "safest balance sheet" screen.
   */
  interestCoverage?: number;
  /**
   * `revenue / average totalAssets`, where the average needs the PRIOR filing's
   * balance sheet. With only one filing this is left undefined rather than
   * computed off a point-in-time denominator, which would overstate turnover
   * for any company that grew its asset base during the period.
   */
  assetTurnover?: number;
  /** Year-over-year, in PERCENT, when a prior-year filing is supplied. */
  revenueGrowth?: number;
  earningsGrowth?: number;
  /**
   * Quarter-over-quarter, in PERCENT, when the IMMEDIATELY PRECEDING quarter is
   * supplied. Reported separately from YoY because Indian earnings are strongly
   * seasonal — a festive quarter against a monsoon quarter is a calendar
   * artefact — and the caller owns which filing it hands in.
   */
  revenueGrowthQoQ?: number;
  earningsGrowthQoQ?: number;
  /** Banking-only, passed through from the filing rather than derived. */
  grossNpaRatio?: number;
  netNpaRatio?: number;
  cet1Ratio?: number;
}

/**
 * Divide, refusing every degenerate case rather than emitting a poisoned value.
 *
 * The rule that matters: a ZERO or NEGATIVE denominator returns undefined, not
 * Infinity and not a large negative. Both of those flow into a chart or a
 * screener filter and sort to an extreme, so a company with zero equity would
 * top a "highest ROE" list. This is the non-finite defect class that keeps
 * recurring in this repo, caught at the only place it can be.
 */
function ratio(
  numerator: number | undefined,
  denominator: number | undefined,
  opts?: { allowNegativeDenominator?: boolean },
): number | undefined {
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return undefined;
  }
  if (denominator === 0) return undefined;
  if (denominator < 0 && opts?.allowNegativeDenominator !== true) {
    return undefined;
  }
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : undefined;
}

function pct(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  const r = ratio(numerator, denominator);
  return r === undefined ? undefined : r * 100;
}

/**
 * Derive ratios from one filing, optionally against the same quarter a year
 * earlier for the growth figures.
 *
 * `priorYear` must be the SAME quarter of the previous year, not the previous
 * quarter. Indian earnings are strongly seasonal — festive-quarter revenue
 * against monsoon-quarter revenue produces a growth number that is entirely an
 * artefact of the calendar. The caller owns that selection; this function
 * documents the requirement and cannot check it, which is why growth is only
 * computed when a prior filing is explicitly handed in.
 */
export function deriveRatios(
  f: RatioInputs,
  priorYear?: RatioInputs,
): DerivedRatios {
  const p = projectFinancials(f);
  const inc = p.income;
  const bs = p.balanceSheet;
  const v = f.values;

  const out: DerivedRatios = {};

  const netMargin = pct(inc?.netIncome, inc?.revenueFromOperations);
  if (netMargin !== undefined) out.netMargin = netMargin;

  const operatingMargin = pct(
    inc?.operatingIncomeExOtherIncome,
    inc?.revenueFromOperations,
  );
  if (operatingMargin !== undefined) out.operatingMargin = operatingMargin;

  // ROE/ROA on a QUARTERLY filing is a quarterly return, NOT an annual one.
  // Deliberately not annualised here: multiplying a seasonal quarter by four is
  // a forecast dressed as a measurement. The caller annualises if it wants to,
  // knowingly.
  // `roe` and `roa` are NOT derived here — see the `priorYear` block below.
  //
  // Both are a FLOW over a STOCK (a year's profit over a balance that moved all
  // year), so a point-in-time denominator overstates the return of any company
  // whose equity or assets grew — which is most of them. This function already
  // makes that argument for `assetTurnover` and did not apply it to these two.
  //
  // Measured against the vendor on prod (583 symbols, same period, only the
  // denominator changed): CLOSING equity matches 45.3%, AVERAGE equity matches
  // 89.5% — 92.5% on consolidated filings. Twelve symbols reproduce the vendor
  // to 0.00%. It is an identity, not a correlation.

  const de = ratio(bs?.totalDebt, bs?.totalEquity);
  if (de !== undefined) out.debtToEquity = de;

  // ── MONEY-1115 additions ──────────────────────────────────────────────
  //
  // EBIT and EBITDA are BUILT here rather than read: the taxonomy publishes
  // neither. `profitBeforeTax` is the honest starting point — using
  // `profitForPeriod` would fold tax into a pre-tax measure.
  //
  // ## Lenders are excluded, for the reason `projectFinancials` already gives
  //
  // `projectFinancials` (this file) refuses to emit `ebitda` for the banking
  // and nbfc families: "Finance cost IS a bank's cost of goods; adding interest
  // expended back produces a number with no meaning." Every metric below is
  // built on exactly that add-back, so the same refusal must apply — deriving
  // them here would contradict a decision made thirty lines up.
  //
  // Measured on this repo's own fixtures before the guard existed: ICICI Bank
  // got interestCoverage 1.76 and roce 9.4; Religare got ebitdaMargin -673.2
  // and interestCoverage -63.0. Coverage near 1.5 is what a distressed borrower
  // looks like, so EVERY lender would sort to the bottom of a "can it service
  // its debt" screen — in a column whose honest incumbent is NULL for all of
  // HDFCBANK, ICICIBANK, SBIN, KOTAKBANK, AXISBANK and BAJFINANCE.
  //
  // ROCE is doubly wrong for a lender: the denominator would be capital +
  // reserves + borrowings, EXCLUDING deposits — most of the funding — while the
  // numerator adds back the interest paid on them.
  const isLender = isLenderFamily(f.family);

  const pbt = num(v, "profitBeforeTax");
  const fin = num(v, "financeCosts");
  const dep = num(v, "depreciationAndAmortisation");

  // EXCEPTIONAL ITEMS ARE REMOVED HERE TOO — MONEY-1239.
  //
  // `projectFinancials` subtracts `exceptionalAdjustment(v)` from EBITDA and
  // `deriveTtm` does the same per quarter; this function did not, so the two
  // tables disagreed about the SAME filing. Probed on a BHARTIARTL-shaped
  // filing: `projectFinancials().income.ebitdaBeforeExceptionalItems` = +14,131 cr
  // (a +66.9% margin)
  // while `deriveRatios().ebitdaMargin` came out at −78.5%. The −103.1%
  // `ebitdaMargin` that MONEY-1239's own docstring names as the harm it fixes
  // was still being produced — by this function.
  //
  // EBIT carries the adjustment for the same reason EBITDA does: an exceptional
  // charge sits inside PBT, so it distorts operating earnings at every level.
  // `roce` and `interestCoverage` both read this `ebit`, and leaving them on the
  // raw basis would put three published ratios on two different definitions.
  const exceptional = exceptionalAdjustment(v);
  const ebit =
    isLender || pbt === undefined || fin === undefined
      ? undefined
      : pbt + fin - exceptional;
  // The components route first, then the projection's own answer — MONEY-1346.
  //
  // INERT for every XBRL filing, by construction rather than by hope: for a
  // non-lender `projectFinancials` builds `ebitdaBeforeExceptionalItems` as
  // `sumAll([pbt, financeCosts, depreciation]) - exceptionalAdjustment(v)` and
  // the expression above is `(pbt + financeCosts - exceptional) + depreciation`
  // — the same three terms and the same adjustment, refused under the same
  // `isLenderFamily` predicate. So the two are defined together and undefined
  // together for anything parsed out of a filing, and the `??` can only fire
  // for a source that reported the line DIRECTLY (see `ReportedIncomeLines`).
  //
  // The lender refusal survives because `ebit` is already undefined for one and
  // `projectFinancials` refuses `ebitdaBeforeExceptionalItems` for one too.
  const ebitda =
    ebit === undefined || dep === undefined
      ? inc?.ebitdaBeforeExceptionalItems
      : ebit + dep;

  const ebitdaMargin = pct(ebitda, inc?.revenueFromOperations);
  if (ebitdaMargin !== undefined) out.ebitdaMargin = ebitdaMargin;

  // Capital employed = equity + ALL borrowings. Both borrowing legs are
  // optional in the source, and a company with only one of them is ordinary —
  // so a missing leg contributes 0 ONLY when the other is present. If neither
  // is present there is no borrowings figure at all and ROCE is refused rather
  // than silently becoming ROE.
  const bc = num(v, "borrowingsCurrent");
  const bnc = num(v, "borrowingsNonCurrent");
  const bankBorrowings = num(v, "borrowings"); // RBI Form-A shape
  const borrowings =
    bc === undefined && bnc === undefined
      ? bankBorrowings
      : (bc ?? 0) + (bnc ?? 0);

  const capitalEmployed =
    bs?.totalEquity === undefined || borrowings === undefined
      ? undefined
      : bs.totalEquity + borrowings;
  const roce = pct(ebit, capitalEmployed);
  if (roce !== undefined) out.roce = roce;

  // Zero finance cost => coverage is UNDEFINED, not infinite. `ratio()` already
  // refuses a zero denominator; this comment records why that is the right
  // answer rather than a missing special case.
  const cover = ratio(ebit, fin);
  if (cover !== undefined) out.interestCoverage = cover;

  // Banking passthrough.

  // Banking ratios are DISCLOSED, not derived — pass them through rather than
  // recomputing from GNPA/advances, which would disagree with the bank's own
  // published figure over a definitional detail we cannot see.
  const gnpa = num(v, "grossNpaRatio");
  if (gnpa !== undefined) out.grossNpaRatio = gnpa;
  const nnpa = num(v, "netNpaRatio");
  if (nnpa !== undefined) out.netNpaRatio = nnpa;
  const cet1 = num(v, "cet1Ratio");
  if (cet1 !== undefined) out.cet1Ratio = cet1;

  if (priorYear) {
    const prior = projectFinancials(priorYear);
    // The caller hands us the SECOND-NEWEST annual, which is not necessarily the
    // PRIOR fiscal year — only 59.7% of judged symbols hold the adjacent one.
    // Averaging across a gap produces a number with no referent, so every
    // averaged ratio below is gated on this. See `isAdjacentAnnual`.
    const adjacent = isAdjacentAnnual(f, priorYear);

    if (adjacent) {
      deriveReturns(
        out,
        inc?.netIncome,
        mean(bs?.totalEquity, prior.balanceSheet?.totalEquity),
        mean(bs?.totalAssets, prior.balanceSheet?.totalAssets),
        "AVERAGE",
      );
    }

    // Asset turnover uses the AVERAGE asset base across the two filings. A
    // point-in-time denominator overstates turnover for any company that grew
    // its assets during the period, which is most of them.
    //
    // `adjacent` added by MONEY-1250: this was the precedent the two ratios
    // above now follow, and it carried the un-checked gap exposure they are
    // gated against.
    if (
      adjacent &&
      inc?.revenueFromOperations !== undefined &&
      bs?.totalAssets !== undefined &&
      prior.balanceSheet?.totalAssets !== undefined
    ) {
      const avgAssets = (bs.totalAssets + prior.balanceSheet.totalAssets) / 2;
      const at = ratio(inc.revenueFromOperations, avgAssets);
      if (at !== undefined) out.assetTurnover = at;
    }

    // Growth needs a POSITIVE base. Percentage change off a negative or zero
    // base is not interpretable: a loss narrowing from -100 to -50 is not
    // "-50% growth", and every sign convention for it is defensible, which is
    // exactly why none should be picked silently.
    //
    // AND IT NEEDS THE SAME ENTITY IN BOTH YEARS — MONEY-1346. These two were
    // the only ratios in this block computed OUTSIDE `adjacent`, which made
    // them the one place the consolidation gap could still be published as a
    // result. `selectPeriodWinners` (and `selectAnnualExtractsByPeriod` on the
    // document side) both group WITHOUT `basis`, so the pair handed here can
    // legitimately be a CONSOLIDATED closing against a STANDALONE prior — and
    // for any holding company those differ by a MULTIPLE (360ONE FY2025 total
    // assets: 19,768 Cr against 7,332 Cr). "Revenue grew 170%" would then be
    // the group/parent ratio wearing a growth label, with nothing on the row
    // to reveal it. That is MONEY-1235 exactly, and `isAdjacentAnnual` was
    // already the guard for it — the averaged ratios above just happened to be
    // the only callers.
    //
    // The second half of `adjacent` matters here too and is not incidental:
    // a prior more than one fiscal year back makes this a MULTI-year change
    // published in a column every reader takes for year-on-year.
    //
    // The cost is real and is already counted: `planRatiosWrite`'s `unfilled`
    // rises for the non-adjacent cohort (35.9% of symbols land there, measured
    // 2026-08-23), so this trades a wrong number for a countable absent one.
    if (adjacent) {
      const rg = growthPct(
        inc?.revenueFromOperations,
        prior.income?.revenueFromOperations,
      );
      if (rg !== undefined) out.revenueGrowth = rg;
      const eg = growthPct(inc?.netIncome, prior.income?.netIncome);
      if (eg !== undefined) out.earningsGrowth = eg;
    }
  }

  // CLOSING FALLBACK — MONEY-1250. Reached when there was no adjacent prior, so
  // `returnBasis` is still unset. Both answers are defensible; what is not
  // defensible is publishing them in one column without saying which. 35.9% of
  // symbols land here (845 of 2,353 measured 2026-08-23), and refusing them
  // would take some under `isPlanWorthWriting`'s three-field floor and cost
  // them every ratio, not just these two.
  if (out.returnBasis === undefined) {
    deriveReturns(
      out,
      inc?.netIncome,
      bs?.totalEquity,
      bs?.totalAssets,
      "CLOSING",
    );
  }

  return out;
}

/**
 * Write `roe`/`roa` and STAMP the denominator they used — MONEY-1250.
 *
 * One function for both bases so the two can never drift into different guards:
 * `pct` already refuses a zero or negative denominator (negative equity yields
 * no ratio, not a large negative one), and `returnBasis` is set only when at
 * least one ratio was actually produced — an empty stamp would assert a
 * derivation that did not happen.
 */
function deriveReturns(
  out: DerivedRatios,
  netIncome: number | undefined,
  equity: number | undefined,
  assets: number | undefined,
  basis: "AVERAGE" | "CLOSING",
): void {
  const roe = pct(netIncome, equity);
  const roa = pct(netIncome, assets);
  if (roe !== undefined) out.roe = roe;
  if (roa !== undefined) out.roa = roa;
  if (roe !== undefined || roa !== undefined) out.returnBasis = basis;
}

/**
 * Quarter-over-quarter growth, from the IMMEDIATELY PRECEDING quarter.
 *
 * Separate from {@link deriveRatios}'s `priorYear` argument on purpose. Both are
 * "the previous filing" structurally, and nothing in the data distinguishes
 * them — so a single parameter would let a caller pass last quarter where last
 * year was meant and get a seasonally-meaningless number with no error. Two
 * named entry points make the caller state which comparison it is making.
 */
export function deriveGrowthQoQ(
  f: XbrlFinancials,
  priorQuarter: XbrlFinancials,
): Pick<DerivedRatios, "revenueGrowthQoQ" | "earningsGrowthQoQ"> {
  const cur = projectFinancials(f).income;
  const prev = projectFinancials(priorQuarter).income;
  const out: Pick<DerivedRatios, "revenueGrowthQoQ" | "earningsGrowthQoQ"> = {};
  const rg = growthPct(cur?.revenueFromOperations, prev?.revenueFromOperations);
  if (rg !== undefined) out.revenueGrowthQoQ = rg;
  const eg = growthPct(cur?.netIncome, prev?.netIncome);
  if (eg !== undefined) out.earningsGrowthQoQ = eg;
  return out;
}

/** A trailing-twelve-month aggregate built from four discrete quarters. */
export interface TtmAggregate {
  revenue?: number;
  netIncome?: number;
  /**
   * Absent for LENDERS, exactly as `projectFinancials` and `deriveRatios`
   * refuse it — see {@link isLenderFamily}. Revenue, netIncome and eps are
   * still summed: the refusal is scoped to the interest add-back, not to
   * lenders wholesale.
   */
  ebitda?: number;
  /** Basic EPS summed across the four quarters — the P/E denominator. */
  eps?: number;
  /** The four period-ends used, newest first. Provenance for the caller. */
  periodEnds: Date[];
}

/**
 * One quarter handed to {@link deriveTtm}.
 *
 * `cumulative` is REQUIRED and supplied by the caller because the parsed
 * document cannot answer it: `XbrlFinancials` carries no such flag, and the
 * writer takes it from the INDEX entry (`xbrl-sync.ts:529`), not the XML. A
 * signature that read it off the filing would be reading a field that does not
 * exist; one that defaulted it to `false` would silently admit the YTD columns
 * this function exists to exclude.
 */
export interface TtmQuarter {
  financials: XbrlFinancials;
  /** From `XbrlFiling.cumulative` — the stored row, not the document. */
  cumulative: boolean;
}

/**
 * Every quarter in a TTM must share ONE reporting basis.
 *
 * `XbrlFiling`'s unique key deliberately keeps the standalone and consolidated
 * filings for a period as separate rows, so a caller assembling "the last four
 * quarters" by period-end alone can pick up two of each. The duplicate-end
 * guard cannot see it — the ends are distinct — and the sum is silently a
 * blend. `selectFilingForPeriod`'s doc states the stakes: the two bases "differ
 * by a MULTIPLE for any holding company".
 *
 * Mixing consolidated 1000s with standalone 100s yields 2200, where the true
 * consolidated year is 4000 and the true standalone year is 400. It is not
 * close to either, and nothing downstream can tell.
 */
function ttmBasisIsConsistent(quarters: readonly TtmQuarter[]): boolean {
  return new Set(quarters.map((q) => q.financials.basis)).size === 1;
}

/**
 * Sum four DISCRETE quarters into a trailing-twelve-month figure.
 *
 * ## Why this refuses more than it computes
 *
 * TTM is the single easiest place in this module to manufacture a wrong number
 * that looks right, so every failure mode is refused rather than approximated:
 *
 * 1. **Fewer than four quarters → `null`.** Three quarters annualised by 4/3 is
 *    a forecast. A partial year is not a trailing year.
 * 2. **Any `cumulative` filing → `null`.** Indian filers publish year-to-date
 *    columns alongside discrete ones. Adding a 9-month YTD to three quarters
 *    double-counts most of the year, and the result is plausible enough to pass
 *    review. `XbrlFiling.cumulative` is in the unique key precisely so the two
 *    can coexist; this is where that distinction has to be honoured.
 * 3. **Non-contiguous quarters → `null`.** Four filings spanning six quarters
 *    with a hole is not twelve months. Checked by period-end spacing rather
 *    than by counting rows.
 * 4. **A duplicated period-end → `null`.** Two filings for one quarter (a
 *    revision, or standalone vs consolidated mixed by the caller) would be
 *    summed as two distinct quarters.
 *
 * A field is summed only when ALL FOUR quarters report it. A quarter missing
 * revenue makes TTM revenue `undefined` — not a three-quarter sum labelled as
 * twelve months.
 */
export function deriveTtm(
  quarters: readonly TtmQuarter[],
): TtmAggregate | null {
  if (quarters.length !== 4) return null;
  if (quarters.some((q) => q.cumulative)) return null;
  if (!ttmBasisIsConsistent(quarters)) return null;

  // `XbrlPeriod.end` is an ISO `YYYY-MM-DD` STRING, not a Date.
  const rows = quarters.map((q) => ({
    f: q.financials,
    endIso: q.financials.period.end,
    end: new Date(`${q.financials.period.end}T00:00:00Z`),
    days: q.financials.period.days,
  }));

  if (rows.some((r) => Number.isNaN(r.end.getTime()))) return null;
  // A discrete quarter is ~90 days. Materially longer is a YTD column that the
  // index did not flag; much shorter is a stub period.
  if (rows.some((r) => r.days < 60 || r.days > 120)) return null;

  const sorted = [...rows].sort((a, b) => b.end.getTime() - a.end.getTime());
  const ends = sorted.map((r) => r.end);

  if (new Set(sorted.map((r) => r.endIso)).size !== 4) return null;

  // Contiguity: consecutive quarter-ends sit 80-100 days apart. Wider means a
  // missing quarter, and the four rows would still sum to a plausible-looking
  // number covering fifteen months.
  for (let i = 0; i + 1 < ends.length; i++) {
    const gap =
      (ends[i]!.getTime() - ends[i + 1]!.getTime()) / (1000 * 60 * 60 * 24);
    if (gap < 80 || gap > 100) return null;
  }

  const projected = sorted.map((r) => projectFinancials(r.f).income);

  const sumAll = (
    pick: (p: ProjectedFinancials | null) => number | undefined,
  ) => {
    let total = 0;
    for (const p of projected) {
      const v = pick(p);
      if (v === undefined) return undefined; // all four, or none
      total += v;
    }
    return total;
  };

  const out: TtmAggregate = { periodEnds: ends };

  const rev = sumAll((p) => p?.revenueFromOperations);
  if (rev !== undefined) out.revenue = rev;
  const ni = sumAll((p) => p?.netIncome);
  if (ni !== undefined) out.netIncome = ni;

  // EBITDA is rebuilt per quarter from the same PBT + finance + D&A route
  // deriveRatios uses, then summed — summing four margins would be meaningless.
  //
  // ## …and the LENDER refusal travels with the route — MONEY-1239
  //
  // `projectFinancials` refuses `ebitda` for banking/nbfc ("Finance cost IS a
  // bank's cost of goods; adding interest expended back produces a number with
  // no meaning") and `deriveRatios` repeats the refusal for everything built on
  // that add-back. This loop rebuilds the SAME quantity and had no such guard,
  // so `ttmEbitda` reached `deriveValuation` and `StockRatios.evToEbitda` was
  // written for every NBFC — the one number this module twice declines to
  // produce, under a source stamp that outranks the incumbent.
  //
  // Banks were spared only by accident: RBI Form-A carries no
  // `DepreciationDepletionAndAmortisationExpense`, so `dep` was undefined and
  // the sum refused itself. An NBFC files Ind-AS and DOES report depreciation
  // (RELIGARE Q4-FY26: PBT −12.36 cr, finance costs 0.19 cr, depreciation
  // 0.56 cr), so nothing stopped it there. Relying on a missing tag is not a
  // guard; this is.
  //
  // `.some` rather than a single read because the quarters are only guaranteed
  // to share a BASIS, not a family — a filer reclassified mid-year must refuse
  // rather than take whichever quarter sorted first.
  const anyLender = sorted.some((r) => isLenderFamily(r.f.family));
  let ebitdaTotal = 0;
  let ebitdaOk = !anyLender;
  let epsTotal = 0;
  let epsOk = true;
  for (const r of sorted) {
    const v = r.f.values;
    const pbt = num(v, "profitBeforeTax");
    const fin = num(v, "financeCosts");
    const dep = num(v, "depreciationAndAmortisation");
    if (pbt === undefined || fin === undefined || dep === undefined) {
      ebitdaOk = false;
    } else {
      // Same removal as the single-period path, per quarter — MONEY-1239. A TTM
      // that keeps an exceptional item four quarters after the event is the
      // same defect with a longer memory.
      ebitdaTotal += pbt + fin + dep - exceptionalAdjustment(v);
    }
    const eps = num(v, "basicEps");
    if (eps === undefined) epsOk = false;
    else epsTotal += eps;
  }
  if (ebitdaOk) out.ebitda = ebitdaTotal;
  if (epsOk) out.eps = epsTotal;

  return out;
}

// ─── Which ROW a filing belongs in ───────────────────────────────────

/**
 * The source string a projection write stamps on `StockFinancials.source`.
 * Named rather than inlined so the writer, the authority table and the tests
 * cannot drift into three spellings of the same thing.
 */
export const XBRL_SOURCE: FinancialsSource = "NSE_XBRL";

/**
 * `StockFinancials.period` is a LABEL ("Q3-2024", "FY 2024"), not a date, while
 * `XbrlFiling` stores real period dates. Deriving the same label is the JOIN
 * between the two tables, and getting it wrong does not error — it pairs Q2
 * against Q3, or finds no incumbent at all and quietly writes a SECOND row for
 * a period that already had one.
 *
 * Indian fiscal years run April→March, so the quarter containing a period-end
 * is (month − 3) / 3, and the FY label is the calendar year the fiscal year
 * ENDS in — the NEXT year for Jan/Feb/Mar period ends.
 *
 * ## Two things this deliberately does NOT do
 *
 *  1. It does not special-case December-year-end filers (ABB, Castrol, Nestlé
 *     historically). Their CY2024 annual lands under "2025". That is arguably
 *     wrong, and it is nonetheless what must happen: this label's ONLY job is
 *     to address the same row `scripts/data/xbrl-reconcile.ts` addressed when
 *     it produced the evidence. A label that is "more correct" than the
 *     reconciliation's is a label that writes somewhere the reconciliation
 *     never looked.
 *  2. It does not validate that Tickertape spells its labels this way.
 *     Tickertape's `period` string is stored VERBATIM from its feed
 *     (`mapQuarterlyIncomeRow`), so this derivation is an assumption about a
 *     third party's formatting. It fails CLOSED — a mismatch makes every
 *     comparison INCOMPARABLE, and `judgeSwitchoverReadiness` then blocks
 *     every field — which is exactly why the writer must not CREATE rows by
 *     default. See `createMissing` in
 *     `workers/src/processors/xbrl-projection-writer.ts`.
 *
 * ## The `FY ` prefix is measured, not guessed (MONEY-1204)
 *
 * This function returned a bare `String(fyEndYear)` — `"2025"` — until it was
 * checked against the table it joins to. Prod `stock_financials` is 32,359
 * rows, ALL `periodType:"ANNUAL"`, and every label carries the prefix:
 * `"FY 2025"` (6,323), `"FY 2024"` (6,285), `"FY 2023"` (6,091),
 * `"FY 2022"` (5,884), `"FY 2021"` (5,629), `"FY 2020"` (24). The bare form
 * appears ZERO times, so the join missed 100% of rows and every projection
 * would have been a CREATE — the exact signature `createMissing:false` exists
 * to catch. The guard worked; the label was wrong.
 *
 * `"TTM"` (2,123 rows) is also stored under `periodType:"ANNUAL"`. It is not a
 * fiscal year and this function must never emit it: a real filing covers a real
 * period, so XBRL must not target the trailing-twelve-month row.
 */
export function periodLabel(periodEnd: Date, periodType: string): string {
  const m = periodEnd.getUTCMonth() + 1;
  const y = periodEnd.getUTCFullYear();

  // ANNUAL: the label is the year the FISCAL YEAR ENDS IN, which for an annual
  // filing is simply `periodEnd`'s year — MONEY-1232.
  //
  // THE BUG this replaces was `m <= 3 ? y : y + 1`, and the reason it survived
  // is worth keeping: for an April-March filer `periodEnd` is ALWAYS in March,
  // so `m <= 3` always holds and the `y + 1` branch NEVER FIRES. That branch
  // executed only for the ~1% of filers whose year does not end in March, and
  // it was wrong for exactly them. Every fixture in the suite was a March
  // year-end, so nothing failed.
  //
  // Measured on prod 2026-08-20 (ANNUAL, by fiscal-year-end month):
  //   March 10,863 filings / 1,854 symbols   June 16 / 4
  //   December 95 / 20                       September 8 / 1
  //
  // SANOFI is the worked example: a Dec-2021 year-end got `FY 2022` while the
  // incumbent Tickertape row calls the same year `FY 2021`, with the VALUES
  // identical on both sides (netIncome 944.4, ebitda 1326.1). `period` is part
  // of `StockFinancials`'s unique key and `judgeProjectionEligibility` builds
  // `verdict.target.period` from this function, so the wrong label does not
  // merely mis-join a comparison — it makes the writer CREATE a second row for
  // a year that already has one, under a name no reader will look for.
  if (periodType === "ANNUAL") return `FY ${y}`;

  // QUARTERLY still assumes an April-March year, and for the 25 non-March
  // filers the quarter INDEX is therefore wrong (a December filer's Jan-Mar
  // quarter is their Q1, and this returns Q4). Deliberately NOT fixed here:
  // deriving it needs the filer's own fiscal-year-end month, which is not in
  // this function's arguments, and the stakes are far lower than the annual
  // case — `stock_financials` holds ZERO quarterly rows today, so every
  // quarterly write is a CREATE either way and no incumbent can be duplicated.
  // Tracked separately rather than half-fixed behind a plausible-looking guess.
  const fyEndYear = m <= 3 ? y : y + 1;
  const q = Math.floor(((m - 4 + 12) % 12) / 3) + 1;
  return `Q${q}-${fyEndYear}`;
}

/** Why a filing may not be projected into `StockFinancials`. */
export type ProjectionRefusal =
  /** `StockFinancials.periodType` has no half-yearly bucket. */
  | "HALF_YEARLY_HAS_NO_BUCKET"
  /** A year-to-date column cannot be written into a discrete-quarter cell. */
  | "CUMULATIVE_IS_NOT_A_QUARTER"
  /** The declared period type and the actual period LENGTH disagree. */
  | "PERIOD_SPAN_CONTRADICTS_TYPE"
  /** periodStart/periodEnd unusable. */
  | "NO_USABLE_PERIOD";

export interface FilingRowIdentity {
  periodType: "ANNUAL" | "QUARTERLY";
  period: string;
}

export type EligibilityVerdict =
  | { eligible: true; target: FilingRowIdentity }
  | { eligible: false; refusal: ProjectionRefusal; detail: string };

/** A quarter is ~91 days. The window is wide enough for 61-day stubs. */
const QUARTER_SPAN_DAYS = { min: 45, max: 150 };
/** A year is 365/366. The window absorbs 52/53-week filers. */
const ANNUAL_SPAN_DAYS = { min: 300, max: 400 };

/**
 * May this filing's numbers be written into `StockFinancials`, and into WHICH
 * row?
 *
 * Every refusal here guards a write that would have succeeded and been wrong by
 * a MULTIPLE — the failure mode with no error, no outlier, and no way to notice
 * from the row itself:
 *
 *   - **HALF_YEARLY.** `StockFinancials.periodType` is ANNUAL | QUARTERLY only.
 *     `xbrl-reconcile.ts` maps everything non-annual to QUARTERLY, which is
 *     harmless in a read-only report (it produces a visible DISAGREEMENT) and
 *     catastrophic in a writer: six months of revenue in a three-month cell,
 *     roughly 2×, sitting under a plausible label.
 *   - **CUMULATIVE.** The nine-month roll-up shares its `periodEnd` with Q3 —
 *     which is precisely why `cumulative` is in `XbrlFiling`'s unique key. Its
 *     revenue is ~3× the quarter's. Refused for quarters; ALLOWED for annual,
 *     where the twelve-month cumulative IS the annual figure.
 *   - **SPAN vs TYPE.** `periodType` can come from the INDEX (a catalogue)
 *     while the numbers come from the DOCUMENT. When the index says Quarterly
 *     and the document's period is 365 days, one of them is describing a
 *     different column, and writing either into the other's cell is a 4×. The
 *     span is stored (periodStart AND periodEnd), so this contradiction is
 *     checkable rather than merely regrettable.
 *
 * Refusing drops the filing's balance sheet along with its P&L, even though a
 * balance sheet is an INSTANT and carries no span problem. That costs coverage
 * on H1 filings specifically, and it is the deliberate trade: a coverage gap is
 * visible as an absent row, a 2× is not visible at all.
 */
export function judgeProjectionEligibility(meta: {
  periodStart: Date;
  periodEnd: Date;
  periodType: string;
  cumulative: boolean;
}): EligibilityVerdict {
  const startMs = meta.periodStart?.getTime?.();
  const endMs = meta.periodEnd?.getTime?.();
  if (
    typeof startMs !== "number" ||
    typeof endMs !== "number" ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return {
      eligible: false,
      refusal: "NO_USABLE_PERIOD",
      detail: "periodStart/periodEnd missing, unparseable, or not ordered",
    };
  }

  if (meta.periodType === "HALF_YEARLY") {
    return {
      eligible: false,
      refusal: "HALF_YEARLY_HAS_NO_BUCKET",
      detail:
        "StockFinancials.periodType is ANNUAL|QUARTERLY; folding six months " +
        "into a quarter cell is a silent ~2x",
    };
  }

  const spanDays = Math.round((endMs - startMs) / 86_400_000);
  const isAnnual = meta.periodType === "ANNUAL";

  if (!isAnnual && meta.cumulative) {
    return {
      eligible: false,
      refusal: "CUMULATIVE_IS_NOT_A_QUARTER",
      detail:
        "a year-to-date column shares its periodEnd with the discrete quarter " +
        "and is ~3x its revenue",
    };
  }

  const window = isAnnual ? ANNUAL_SPAN_DAYS : QUARTER_SPAN_DAYS;
  if (spanDays < window.min || spanDays > window.max) {
    return {
      eligible: false,
      refusal: "PERIOD_SPAN_CONTRADICTS_TYPE",
      detail:
        `periodType=${meta.periodType} but the period spans ${spanDays} day(s) ` +
        `(expected ${window.min}–${window.max})`,
    };
  }

  return {
    eligible: true,
    target: {
      periodType: isAnnual ? "ANNUAL" : "QUARTERLY",
      period: periodLabel(meta.periodEnd, meta.periodType),
    },
  };
}

/**
 * How much a basis is worth. Lower is better: CONSOLIDATED, then STANDALONE,
 * then anything we do not recognise (including an absent basis).
 *
 * ## Why this is module-level and not a closure inside the selector
 *
 * It used to be a `const` inside `selectFilingForPeriod`, which was correct for
 * as long as ONE place ranked bases. MONEY-1235 gave it a second caller —
 * `planFinancialsWrite` has to refuse a STANDALONE write over a
 * CONSOLIDATED-derived row — and two copies of an ordering is the exact defect
 * `FINANCIALS_AUTHORITY`'s own comment was written about: a third basis (IFRS
 * segment filings, say) added to one copy and not the other produces two
 * functions that disagree about which filing owns a row, silently, on the one
 * table with no `source` in its unique key.
 *
 * An UNKNOWN basis ranking last rather than throwing is the same choice
 * `rankOf` makes for an unknown source: a vocabulary we have not seen may fill
 * a gap, never displace something we understand.
 */
function basisRank(basis: string | undefined | null): number {
  if (basis === "CONSOLIDATED") return 0;
  if (basis === "STANDALONE") return 1;
  return 2;
}

/**
 * One period, two filings, one row.
 *
 * A company files BOTH consolidated and standalone for the same quarter, and
 * `XbrlFiling`'s key keeps both — deliberately, they are different facts. But
 * `StockFinancials`'s key has NO basis, so both address the SAME row. Left
 * alone that is last-writer-wins between two numbers that differ by a MULTIPLE
 * for any holding company, and it is not even stable: it flips with whatever
 * order the query happened to return, so the row can oscillate between two
 * different truths on alternate nights and no run ever looks wrong.
 *
 * CONSOLIDATED wins because it is the group, which is what a portfolio product
 * means by "the company", and because it is what the vendors we are replacing
 * report. Every remaining tie is broken to a TOTAL order — coverage, then the
 * filing date, then the source URL — so the choice is a function of the
 * candidate SET and not of its order.
 *
 * ## This selector alone is NOT enough — MONEY-1235
 *
 * It is only correct over the filings a run can SEE. The writer groups the
 * current page of UNPROJECTED filings, so a CONSOLIDATED filing projected and
 * stamped on night 1 is invisible on night 2: its STANDALONE sibling, synced
 * later under a different `sourceUrl`, arrives unstamped, forms a SINGLETON
 * group, and wins here trivially. The guard that stops that write is in
 * `planFinancialsWrite`, which compares our basis against the basis recorded in
 * the row's OWN `rawData` — the only place the earlier decision survives.
 */
export function selectFilingForPeriod<
  T extends {
    basis: string;
    coverage?: number | null;
    filedAt?: Date | null;
    sourceUrl?: string | null;
  },
>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  const time = (d: Date | null | undefined): number =>
    d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : -1;

  return [...candidates].sort((a, b) => {
    const byBasis = basisRank(a.basis) - basisRank(b.basis);
    if (byBasis !== 0) return byBasis;
    const byCoverage = (b.coverage ?? 0) - (a.coverage ?? 0);
    if (byCoverage !== 0) return byCoverage;
    const byFiled = time(b.filedAt) - time(a.filedAt);
    if (byFiled !== 0) return byFiled;
    // Last resort, and it must be TOTAL: two filings identical on every field
    // above still have to resolve the same way every run.
    return (a.sourceUrl ?? "").localeCompare(b.sourceUrl ?? "");
  })[0]!;
}

// ─── The write plan ──────────────────────────────────────────────────

/**
 * The `StockFinancials` columns each statement OWNS.
 *
 * "Owns" is load-bearing: a field in this list that the filing did not disclose
 * is written as NULL, not left holding the previous source's number. A row
 * stamped `source: "NSE_XBRL"` whose `ebitda` is still Tickertape's is a row
 * nobody can attribute — the exact condition MONEY-1175 spent months in. The
 * displaced value is not destroyed by that null; it is preserved verbatim in
 * the displacement record below, which is what makes nulling safe.
 *
 * The cash-flow columns are absent from BOTH lists on purpose. This module
 * projects no cash-flow statement, so it has no opinion about them and must not
 * express one.
 *
 * ## `grossProfit` is absent for the SAME reason — MONEY-1235
 *
 * It was in this list until MONEY-1235 and it should never have been. Gross
 * profit needs COST OF GOODS SOLD, and there is no COGS concept in the Ind-AS
 * or IFRS taxonomies NSE files against — `projectFinancials` therefore never
 * emits it, not for one filer, not once. Owning a field we can never fill means
 * writing NULL into it on EVERY row we touch, so the Financials tab would have
 * shown "—" for Gross profit on every XBRL-updated column while the older
 * vendor columns beside it still carried a number. The upgrade would have read
 * as a regression, in the most visible place in the product, and the cause
 * would have been a list rather than a bug anyone could see.
 *
 * Dropping it makes the column UNOWNED, which under partial-update semantics
 * means the patch never mentions it and the incumbent value survives untouched.
 * That is the correct answer for a field we have no opinion about: say nothing,
 * rather than assert an absence we cannot support.
 *
 * ## `revenue`, `operatingIncome` and `ebitda` left for a THIRD reason —
 * MONEY-1255
 *
 * `grossProfit` was dropped because we could never fill it. These three we can
 * fill perfectly well — the problem is that the vendor's column of the same
 * name holds a DIFFERENT QUANTITY, so filling it would not be an upgrade, it
 * would be a redefinition performed silently on a table whose `@@unique`
 * carries no `source`. See {@link UNOWNED_VENDOR_COLUMNS} for the evidence and
 * for the columns that replaced them.
 */
export const INCOME_FIELDS = [
  // OUR quantity, under a name that says which quantity it is — MONEY-1255.
  // The vendor's `revenue` column (TOTAL INCOME) is left alone.
  "revenueFromOperations",
  // OWNED because it is DISCLOSED, not derived — MONEY-1250. Every filing
  // probed carries an `OtherIncome` element (Schedule III mandates the line),
  // so unlike `grossProfit` this is a column we can actually fill rather than
  // an absence we would be asserting. It is what lets `ebitdaMargin` and
  // `operatingMargin` be put on ONE basis later without a migration.
  "otherIncome",
  "operatingIncomeExOtherIncome",
  "netIncome",
  "ebitdaBeforeExceptionalItems",
] as const;

/**
 * Vendor columns the XBRL projection deliberately does NOT own — MONEY-1255.
 *
 * Keyed by the column name, valued by the evidence, and printed verbatim by the
 * F3 reconcile. A declaration whose reasoning lives only in a commit message is
 * indistinguishable from a suppression six months later — the same standard
 * `DECLARED_DIVERGENCES` in `scripts/data/xbrl-ratios-validate.ts` holds itself
 * to.
 *
 * ## Why NOT-CLAIMING rather than declaring a divergence
 *
 * A declared divergence keeps the write and annotates it. That is the right
 * instrument when we DO own the column and our figure is simply on a different
 * footing (`totalDebt`, whose vendor value includes Ind-AS 116 lease
 * liabilities we cannot source). It is the wrong instrument here, because the
 * write is the harm: `StockFinancials` has no `source` in its unique key, so
 * the first XBRL write for a period replaces the vendor's TOTAL INCOME with our
 * REVENUE FROM OPERATIONS, under a column still labelled `revenue`, with no
 * second copy anywhere. Every downstream reader — the Financials tab, the
 * research tools, `deriveRatios`' margins — would then be dividing by a
 * different denominator than the row beside it, and nothing about the row would
 * say so.
 *
 * Not owning the column removes the whole class: an unowned field cannot be
 * written, cannot be nulled, and cannot drift. Our figures are not lost — they
 * are in {@link INCOME_FIELDS} under names that state what they measure.
 *
 * ## Measured on prod (full annual universe, 2026-08-26)
 *
 * Each pair below is "the gate's disagreement rate counting the declared
 * reconstruction as agreement" against "the same rate with it demoted":
 *
 *     revenue          18.9% vs 71.9%   theirs = ours + otherIncome (2,529 pairs)
 *     operatingIncome  28.4% vs 95.9%   theirs = ours + otherIncome (3,014 pairs)
 *     ebitda           26.7% vs 42.7%   theirs = ours + exceptionalItems (824)
 *
 * A gap that large, that one-directional, and that exactly explained by a
 * single named line item is a definition difference, not a data defect. Three
 * magnitudes, one phenomenon for the first two: the same absolute other-income
 * amount over three different denominators. `netIncome` has no such gap (p50
 * 0.01%, 86.9% within 1%) and is therefore still OWNED — which is the control
 * that keeps this from being "stop writing whatever disagrees".
 *
 * ## NOT-CLAIMING PRESERVES THE VALUE, NOT THE ABILITY TO REFRESH IT
 *
 * "The vendor's value survives untouched" is true and incomplete, and the gap
 * matters the moment anyone revives a vendor writer. `mayOverwriteFinancials`
 * is ROW-level, not column-level: once the projection stamps a row
 * `NSE_XBRL`, a later TICKERTAPE or SCREENER write is refused for the WHOLE
 * ROW — including these three columns, which we deliberately do not own and
 * which only the vendor can fill. So the numbers below are preserved as they
 * stood at the moment of the first XBRL write, and then FROZEN: nothing can
 * ever update them again.
 *
 * That costs nothing TODAY, and only because both vendor writers are dead —
 * `financial-data-sync` is retired (Tickertape 403s our Cloud Run egress) and
 * the request-time Screener persist cannot fire (its chain result carries no
 * statement arrays). It stops being free the moment either is revived. The fix
 * at that point is a column-scoped authority check, NOT widening ownership
 * back over columns whose definition we know we disagree with.
 */
export const UNOWNED_VENDOR_COLUMNS: Readonly<Record<string, string>> = {
  revenue:
    `the vendor's \`revenue\` is TOTAL INCOME (revenue from operations + other ` +
    `income); ours is revenue from operations. Measured on the full annual ` +
    `universe, 2,529 of 4,772 comparable pairs agree ONLY under \`ours + ` +
    `otherIncome\`, taking the disagreement rate from 71.9% raw to 18.9% ` +
    `translated. Adjudicated against screener.in as a third source (3MINDIA ` +
    `reconciles 12/12 to the rupee against screener's CONSOLIDATED while the ` +
    `vendor matches its STANDALONE). Our figure is written to ` +
    `\`revenueFromOperations\`; the vendor keeps \`revenue\``,
  operatingIncome:
    `the vendor's \`operatingIncome\` is EBIT INCLUDING other income; ours ` +
    `excludes it by construction (\`revenueFromOperations - totalExpenses + ` +
    `financeCosts\`). 3,014 of 4,462 comparable pairs agree only under \`ours ` +
    `+ otherIncome\`, taking the rate from 95.9% raw to 28.4% translated — the ` +
    `starkest of the three, because the same absolute other-income amount sits ` +
    `over the smallest denominator. Our figure is written to ` +
    `\`operatingIncomeExOtherIncome\`; the vendor keeps \`operatingIncome\``,
  ebitda:
    `the difference runs the OTHER WAY and is EXCEPTIONAL ITEMS, not other ` +
    `income: ours is PBT-derived (so it includes other income) and removes ` +
    `exceptional items, while the vendor's is operations-only and keeps them. ` +
    `Of the reconstructions that resolve an ebitda pair, \`ours + ` +
    `exceptionalItems\` carries 824 and \`ours - otherIncome\` 66; the rate ` +
    `goes 42.7% raw to 26.7% translated. Removing exceptional items is the ` +
    `defensible choice and is not being reverted — a -30,711 Cr AGR provision ` +
    `turned a +8,928 Cr EBITDA into -21,783 Cr and drove \`ebitdaMargin\` to ` +
    `-103% — so the two definitions coexist instead. Our figure is written to ` +
    `\`ebitdaBeforeExceptionalItems\`; the vendor keeps \`ebitda\``,
};

export const BALANCE_SHEET_FIELDS = [
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
] as const;

export type FinancialsField =
  | (typeof INCOME_FIELDS)[number]
  | (typeof BALANCE_SHEET_FIELDS)[number];

export function ownedFields(
  statementType: ProjectedFinancials["statementType"],
): readonly FinancialsField[] {
  return statementType === "INCOME" ? INCOME_FIELDS : BALANCE_SHEET_FIELDS;
}

/**
 * Columns we do NOT source for a LENDER, and therefore must not write — even
 * as a null — MONEY-1239.
 *
 * ## This is the `grossProfit` decision, one dimension further in
 *
 * MONEY-1235 removed `grossProfit` from {@link INCOME_FIELDS} because no COGS
 * concept exists in the taxonomies NSE files against, and the note above that
 * list states the principle: "Owning a field we can never fill means writing
 * NULL into it on EVERY row we touch ... say nothing, rather than assert an
 * absence we cannot support."
 *
 * These two are the same case, except that they are unfillable per FAMILY
 * rather than universally — so ownership has to be declared per family instead
 * of being dropped outright.
 *
 *  - `ebitda`: `projectFinancials` already refuses it for a lender ("interest
 *    expended IS a bank's cost of goods"), and already declines to list it in
 *    `unfilled` because "for a bank there is nothing to fill". The module has
 *    held the correct opinion in two places all along; only this list
 *    disagreed, so the writer nulled a column the projector had deliberately
 *    declined to produce.
 *  - `operatingIncome`: needs `operatingProfitBeforeProvisions`, measured on
 *    prod at 76 of 741 ANNUAL banking filings and 0 of 206 NBFC filings.
 *    `provisionsOtherThanTax` is 74/741 and 0/206, so `PBT + provisions` does
 *    not raise that either. 10% is not sourcing a column; it is nulling 90% of
 *    them.
 *
 * ## Why NOT-CLAIMING beats writing-then-preserving
 *
 * An earlier attempt kept the vendor's number by omitting the key when the
 * projection came up empty. It worked, and it cost: the row was stamped
 * `NSE_XBRL` while two of its columns were not ours, which is the
 * unattributable state MONEY-1175 spent months in — so it also needed an
 * attribution map, a prior-map merge so a refresh could not relabel the column
 * as ours, and a rule that "unchanged" be judged on the post-patch row or the
 * value would be re-nulled the next night.
 *
 * Declaring the column unowned removes all of that. There is no mixed
 * provenance to attribute because nothing was ever claimed, and the incumbent
 * survives for the ordinary reason an unowned column always has: the patch
 * never mentions it.
 *
 * The 10% of banks whose filings DO disclose the RBI line are the stated cost.
 * They keep the vendor's number rather than ours — the column still shows a
 * figure, and consistency about what we source is worth more than one column in
 * ten being fresher.
 */
export const LENDER_UNWRITABLE_FIELDS: ReadonlySet<FinancialsField> = new Set([
  "operatingIncomeExOtherIncome",
  "ebitdaBeforeExceptionalItems",
]);

/**
 * The columns a write may touch for THIS filing — {@link ownedFields} minus
 * anything the filing's family does not support.
 *
 * Deliberately separate from `ownedFields`, which stays the full column list:
 * the displacement record must capture every owned column of the incumbent, and
 * `toCroreDenominated` must convert every column the projector can emit. Only
 * the WRITE is narrowed.
 */
export function writableFields(
  statementType: ProjectedFinancials["statementType"],
  family?: XbrlFinancials["family"],
  // TYPED, not `string` — MONEY-1250 review. A typo used to compile, and an
  // unrecognised value falls through to "not Form-A", which makes the columns
  // WRITABLE. Permissive direction, on a one-way door, on the very function
  // whose omission was MONEY-1236.
  filerShape?: FilerShape,
): readonly FinancialsField[] {
  const all = ownedFields(statementType);
  if (!isLenderFamily(family)) return all;
  const unwritable = new Set<FinancialsField>(LENDER_UNWRITABLE_FIELDS);
  // An RBI Form-A bank does not own `totalDebt` or `totalCash` — MONEY-1250.
  // Keyed on the SHAPE and not on `family`, which is "banking" for 665 NBFC
  // filings that DO own both and would otherwise lose the columns this change
  // exists to fill.
  //
  // `totalCash` is the starker of the two: measured on prod 2026-08-24, ZERO of
  // 84 Form-A filings carry `cashAndCashEquivalents`, and the parser extracts no
  // cash-bearing concept from them at all — a bank reports Schedule 6
  // `CashAndBalancesWithReserveBankOfIndia` and `BalancesWithBanks`, neither of
  // which is in the registry. So the projection could never produce a value, and
  // every write was a guaranteed NULL over a populated vendor figure: HDFCBANK
  // FY2024 22,88,34.51 crore, AXISBANK FY2024 1,16,493.18 crore. The F3 gate
  // could not see this because it graded six columns and selected six columns,
  // so `totalCash` scored INCOMPARABLE for reasons that had nothing to do with
  // the data.
  //
  // Adding those RBI concepts later is a real option, but it is a DEFINITIONAL
  // choice about what a bank's "cash" is, made in front of a one-way door.
  // Declining to claim the column costs nothing and keeps the vendor's value.
  if (filerShape === "RBI_FORM_A") {
    unwritable.add("totalDebt");
    unwritable.add("totalCash");
  }
  return all.filter((f) => !unwritable.has(f));
}

/**
 * Rebase a projected statement from absolute RUPEES into ₹ CRORE — MONEY-1235.
 *
 * ## Why this lives in core rather than beside its caller
 *
 * `StockFinancials` is denominated in ₹ crore — not by declaration but because
 * all 32,359 prod rows came from Tickertape, whose feed is crore. XBRL facts are
 * absolute rupees. The projection writer once wrote the rupee value straight
 * into the crore column: 10,000,000x, on the one table with no `source` in its
 * unique key, so the displaced value is gone.
 *
 * That was fixed in the WRITER. The F3 reconcile, which decides whether the
 * writer may be armed at all, calls `projectFinancials` directly and therefore
 * needed the same rebase — and got its own copy. Two identical conversions then
 * existed in two packages, and if they had ever drifted the gate would have
 * graded numbers the writer will never persist: a gate measuring something
 * other than what ships is the defect class this entire ticket family is about
 * (MONEY-1220 / 1234 / 1235). One definition, imported by both.
 *
 * `rupeesToCrores` returns undefined for absent or non-finite input, so an
 * undisclosed field stays UNDISCLOSED rather than becoming 0 or NaN — the
 * distinction `planFinancialsWrite` turns into "write NULL" versus "write 0".
 * Only `ownedFields` are converted; anything else is not ours to restate.
 */
export function toCroreDenominated(
  statement: ProjectedFinancials,
): ProjectedFinancials {
  const out: ProjectedFinancials = { statementType: statement.statementType };
  for (const field of ownedFields(statement.statementType)) {
    const converted = rupeesToCrores(statement[field]);
    if (converted !== undefined) out[field] = converted;
  }
  return out;
}

/**
 * What a projection write replaced.
 *
 * ## Why this lives INSIDE the row it displaced
 *
 * `StockFinancials.rawData` is a `Json?` column that already means "everything
 * the source said". Three properties decided it over a separate audit table or
 * a run-level log entry:
 *
 *  1. **It is atomic with the overwrite.** Same document, same upsert. A
 *     separate collection is a second write with no transaction around it
 *     (MongoDB, Prisma, no session here), so the audit would be missing exactly
 *     when the process died mid-run — the runs that most need it.
 *  2. **Recovery is a pure function of the row.** Restoring means reading the
 *     row you are looking at. An audit table needs a join, a run id, and the
 *     assumption that the log was not pruned; a run-level `MarketDataSyncLog`
 *     entry needs all that AND cannot hold ~50k displacements without hitting
 *     the 16 MB document limit.
 *  3. **It travels.** `stock_financials` rides the prod→QA copy as itself. A
 *     new collection would have to be added to `sync-prod-to-qa.sh`, and
 *     `market_data_sync_logs` is explicitly EXCLUDED from that copy as
 *     environment-specific — so a run-level record would exist in exactly one
 *     environment.
 *
 * The cost, stated plainly: `rawData` is a shared slot that the Tickertape
 * writer uses for its own raw row. So the record carries `rawData` — whatever
 * the displaced source had put there — rather than assuming a shape, and the
 * writer never nests one record inside another.
 */
export interface DisplacementRecord {
  /** The source whose numbers were replaced ("TICKERTAPE", "SCREENER", …). */
  displacedSource: string;
  /** The source that replaced them. */
  by: FinancialsSource;
  /** ISO timestamp of the displacement. */
  displacedAt: string;
  /** Every OWNED field as it stood, nulls included, so restore is complete. */
  values: Record<string, number | null>;
  /** The displaced row's own `fetchedAt`, when it had one. */
  fetchedAt: string | null;
  /** Whatever the displaced source had in `rawData`. Stored ONCE, never nested. */
  rawData: unknown;
}

/** The `rawData` a projection write leaves behind. */
export interface ProjectionRawData {
  xbrl: {
    /** The filing this row came from — provenance back to the raw side. */
    filing: {
      periodEnd: string;
      periodType: string;
      basis: string;
      cumulative: boolean;
      /**
       * The taxonomy family the filing was parsed under — MONEY-1239. Carried
       * so `planFinancialsWrite` can narrow the writable columns, and stored so
       * a row records which shape it came from.
       */
      family?: string;
      /**
       * The FILING SHAPE — `"RBI_FORM_A"` or `"IND_AS"` — MONEY-1250.
       *
       * Carried SEPARATELY from `family` because `family` is wrong for 665 of
       * 947 lender filings: an NBFC tags `InterestEarned`, which is what the
       * family classifier keys on, so `family` reads "banking" for documents
       * that are Ind-AS Division III. `bankCapital` is the measured
       * discriminator (76 of 76 Form-A, 0 of 871 Ind-AS).
       *
       * Read by {@link writableFields}: a Form-A bank does not OWN `totalDebt`,
       * and "not owned" has to mean the write never mentions the column. An
       * owned-but-omitted field is written as an explicit NULL by
       * `projectedValues`, which asserts an absence rather than declining to
       * claim one.
       */
      filerShape?: FilerShape;
      taxonomyVersion?: string;
      coverage?: number;
      sourceUrl?: string;
    };
    /** The projected statement, exactly as written to the columns. */
    projected: ProjectedFinancials;
    /**
     * Fields the filing could not fill, so a NULL says why it is null — and
     * WHICH CONCEPT was missing, which is the half that used to be thrown away.
     *
     * MONEY-1238. `ProjectionResult.unfilled` is
     * `Array<{ field, needed: XbrlConcept[] }>` and its own doc calls the
     * concept list "the point of the module: an absent number is reported as
     * absent WITH its cause". Both call sites then did `.map(u => u.field)` and
     * stored the field name alone, so what landed in `rawData` was a list of
     * things that are null — which the columns already say, being null. The
     * cause is what makes a null actionable ("`ebitda` is absent because this
     * filing carries no `depreciationAndAmortisation`" is a taxonomy gap;
     * "because `profitBeforeTax` is missing" is a parse bug), and it is
     * reconstructible from nothing else once the run has ended.
     *
     * `needed` is OPTIONAL because a caller may legitimately have only field
     * names in hand (`planFinancialsWrite` still accepts the bare `string[]`
     * form). Absent means "not recorded", never "nothing was needed".
     */
    unfilled: Array<{ field: string; needed?: string[] }>;
  };
  /** Present only when this row displaced another source. */
  displacedByXbrl?: DisplacementRecord;
}

export type FinancialsWriteAction = "CREATE" | "UPDATE" | "SKIP";

/**
 * WHY a plan skipped, as a value rather than as prose.
 *
 * The two original skips are opposites and must be counted apart: `AUTHORITY`
 * means a better source already owns the row (healthy, expected), `UNCHANGED`
 * means we own it and it is already right (healthy, expected, and the proof the
 * job is a fixpoint). A caller that has to tell them apart by matching on
 * `reason` breaks the moment somebody rewords a message — silently, into
 * whichever bucket the match falls through to.
 *
 * MONEY-1235 adds two more, and they must NOT be folded into `AUTHORITY`.
 * `AUTHORITY` means "another SOURCE outranks us" and is a statement about
 * `FINANCIALS_AUTHORITY`; both new reasons are about BASIS, which
 * `FINANCIALS_AUTHORITY` says nothing about, and both are expected to be
 * COMMON rather than rare:
 *
 *   - `BASIS_DOWNGRADE` — our own earlier CONSOLIDATED-derived row would be
 *     rewritten with STANDALONE numbers by a late-arriving sibling.
 *   - `STANDALONE_NO_DISPLACE` — a STANDALONE winner would displace some other
 *     source's (typically consolidated) incumbent. Measured on the F3
 *     population: 3,208 of 10,879 winner periods (29.5%) have standalone-only
 *     XBRL.
 *
 * Counting either as `skippedAuthority` would make a 29.5% policy outcome look
 * like the rare "somebody outranks NSE_XBRL" case — which is currently
 * impossible, NSE_XBRL being first in the order — and nobody would ever ask why
 * that number was so large.
 */
export type FinancialsSkipReason =
  | "AUTHORITY"
  | "UNCHANGED"
  | "BASIS_DOWNGRADE"
  | "STANDALONE_NO_DISPLACE";

export interface FinancialsWritePlan {
  action: FinancialsWriteAction;
  /** Set exactly when `action === "SKIP"`. */
  skipReason?: FinancialsSkipReason;
  /** Always populated — a SKIP with no reason is unauditable. */
  reason: string;
  /** Column patch. Owned fields the filing did not disclose are explicit nulls. */
  values?: Record<string, number | null>;
  source?: FinancialsSource;
  rawData?: ProjectionRawData;
  /** Non-null only on the write that actually displaced another source. */
  displaced?: DisplacementRecord | null;
}

/** The incumbent row, structurally — no Prisma types in this pure module. */
export interface IncumbentFinancialsRow {
  source: string | null;
  fetchedAt?: Date | string | null;
  rawData?: unknown;
  /**
   * `StockFinancials.basis` — the COLUMN, not the `rawData` provenance.
   *
   * ## Why the column is read at all, given the guards prefer `rawData`
   *
   * MONEY-1238. The column was WRITTEN by the projection writer on every create
   * and every update (`basis: winner.basis`, twice) and read by NOTHING. A
   * stored value that no code path consults cannot be wrong in a way anything
   * notices, which is the state a column is in right before it drifts.
   *
   * It is a FALLBACK, never the primary: `rawData.xbrl.filing.basis` stays
   * authoritative because it is written atomically with the numbers it
   * describes, and this column is not in `StockFinancials`' unique key (see
   * CLAUDE.md — adding it would split consolidated and standalone into two rows
   * every reader would double-count). What the fallback closes is the hole the
   * BASIS_DOWNGRADE guard names in its own comment: a row of OURS "whose
   * provenance we cannot read is deliberately left writable". If the column
   * says CONSOLIDATED, the provenance being unreadable is no longer an absence
   * of evidence, and a STANDALONE write is a downgrade we can prove.
   *
   * ABSENT on every pre-existing row and that is expected, not a bug: a Mongo
   * `db push` creates indexes, not fields, so all ~32,359 Tickertape-era rows
   * have no `basis` attribute at all. It arrives here as `undefined`, ranks
   * last, and changes nothing — which is exactly the behaviour a fallback must
   * have on the population it was added after. NEVER filter it with
   * `basis: null` in a query (MONEY-1050 / 1234 / 1235).
   */
  basis?: string | null;
  revenue?: number | null;
  grossProfit?: number | null;
  /**
   * ABSENT on every pre-existing row — MONEY-1250, same shape as `basis` above.
   *
   * The column arrived after ~32,359 vendor-era rows were written, so it is
   * `undefined` for all of them. That is the correct reading: "the incumbent
   * never carried this", not "the incumbent says zero". NEVER filter it with
   * `otherIncome: null` (MONEY-1050 / 1234 / 1235 / 1236).
   */
  otherIncome?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  ebitda?: number | null;
  /**
   * OUR columns — MONEY-1255. Same absent-not-null caveat as `otherIncome`
   * above, and it bites harder here: these arrived after ~32,359 vendor-era
   * rows, so `undefined` is the value for every one of them and a filter of
   * `{not: null}` returns ZERO.
   *
   * They are on this interface because {@link INCOME_FIELDS} owns them, so
   * `incumbentValues` indexes the row by these names when building a
   * displacement record and `sameValues` reads them for the UNCHANGED check.
   * A caller whose `select` omits one gets `undefined` back, which reads as
   * "the row has no value" — the row is then judged CHANGED on every pass and
   * rewritten nightly forever. Select them.
   */
  revenueFromOperations?: number | null;
  operatingIncomeExOtherIncome?: number | null;
  ebitdaBeforeExceptionalItems?: number | null;
  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d instanceof Date)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  if (typeof d === "string" && d.trim() !== "") return d;
  return null;
}

/** Owned columns of the incumbent, normalised to `number | null`. */
function incumbentValues(
  row: IncumbentFinancialsRow,
  fields: readonly FinancialsField[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of fields) {
    const v = row[f];
    out[f] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/** Owned columns of the projection, normalised to `number | null`. */
function projectedValues(
  projected: ProjectedFinancials,
  fields: readonly FinancialsField[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of fields) {
    const v = (projected as unknown as Record<string, unknown>)[f];
    out[f] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

function sameValues(
  a: Record<string, number | null>,
  b: Record<string, number | null>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  }
  return true;
}

/**
 * Read the displacement record already stored on a row, if any.
 *
 * Tolerates ANY `rawData` shape — Tickertape's raw feed row, a seed blob, null,
 * a string. It returns a record only when one is genuinely there, because the
 * whole idempotency argument turns on "has this row already been displaced?"
 * and a wrong answer either loses the original evidence or duplicates it.
 */
export function existingDisplacement(
  rawData: unknown,
): DisplacementRecord | null {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return null;
  }
  const d = (rawData as Record<string, unknown>).displacedByXbrl;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const rec = d as Record<string, unknown>;
  if (typeof rec.displacedSource !== "string") return null;
  return d as unknown as DisplacementRecord;
}

/**
 * The filing provenance already stored on a row, as SCALARS.
 *
 * Deliberately not a deep comparison of the stored `rawData.xbrl` blob against
 * a freshly built one: an object that has round-tripped through Mongo does not
 * preserve our construction's key order, so `JSON.stringify` equality would
 * differ every run in production while matching perfectly in a test with an
 * injected store. That is the "green in the test, churns in prod" shape — four
 * scalars are order-independent and answer the same question.
 */
function storedProvenance(
  rawData: unknown,
): Partial<ProjectionRawData["xbrl"]["filing"]> | null {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return null;
  }
  const x = (rawData as Record<string, unknown>).xbrl;
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const f = (x as Record<string, unknown>).filing;
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  return f as Partial<ProjectionRawData["xbrl"]["filing"]>;
}

function sameProvenance(
  stored: Partial<ProjectionRawData["xbrl"]["filing"]> | null,
  ours: ProjectionRawData["xbrl"]["filing"],
): boolean {
  if (stored === null) return false;
  return (
    stored.sourceUrl === ours.sourceUrl &&
    stored.periodEnd === ours.periodEnd &&
    stored.basis === ours.basis &&
    stored.cumulative === ours.cumulative
  );
}

/**
 * Decide what a projection write does to one `StockFinancials` row.
 *
 * ## The three-way split, and why the middle one is the whole ticket
 *
 *   - **incumbent outranks us** → SKIP. `chooseAuthority` decides; this
 *     function never second-guesses the declared order.
 *   - **we displace a DIFFERENT source** → UPDATE, and record what was there.
 *     This happens exactly ONCE per row, on the first XBRL write.
 *   - **we replace OUR OWN earlier write** (`displaced === challenger`, the
 *     refresh case `chooseAuthority` allows for corrected filings) → UPDATE
 *     WITHOUT touching the existing record.
 *
 * That last branch is the one that makes the audit trail survive. Every nightly
 * re-run after the first is a refresh; if a refresh built a new record, the
 * second run would overwrite "TICKERTAPE said X" with "NSE_XBRL said X" — the
 * Tickertape numbers gone, the row's own history now a tautology, and nothing
 * anywhere reporting a problem. The record is written once and then is
 * immutable.
 *
 * A run that would change nothing returns SKIP rather than an identical write,
 * so the job is a fixpoint: run it twice and the second run touches no rows.
 * That is also what keeps `updatedAt` meaningful.
 *
 * ## The BASIS guards — MONEY-1235, and why `selectFilingForPeriod` misses this
 *
 * `selectFilingForPeriod` picks CONSOLIDATED over STANDALONE, but only among
 * the filings ONE RUN CAN SEE. The writer selects `UNPROJECTED_FILING_WHERE`,
 * so once a CONSOLIDATED filing has been projected and stamped it is gone from
 * every later page. Its STANDALONE sibling is a SEPARATE `XbrlFiling` row
 * (`basis` is in that table's unique key) with its own `sourceUrl`, and
 * `xbrl-sync` stores it whenever NSE publishes it — days later, routinely.
 * That sibling then arrives unstamped, forms a group of ONE, and wins the
 * selector trivially.
 *
 * Nothing downstream caught it. `chooseAuthority` sees NSE_XBRL against
 * NSE_XBRL and returns the EQUAL-rank refresh (`c <= i`), which exists so a
 * corrected filing can replace its own earlier reading. `sameProvenance`
 * compares `stored.basis === ours.basis`, and CONSOLIDATED ≠ STANDALONE, so the
 * UNCHANGED skip does not fire either. The result was an UPDATE counted as a
 * plain `updated`, rewriting group numbers with parent-only ones — a MULTIPLE,
 * for any holding company. HOLDCO consolidated Q2 ₹1,000 Cr projected on night
 * 1; standalone Q2 ₹400 Cr syncs a day later; night 2 leaves the row reading
 * ₹400 Cr, stamped `NSE_XBRL`, with no error anywhere.
 *
 * Two guards, deliberately asymmetric:
 *
 *  1. **Same-source refresh** (NSE_XBRL over NSE_XBRL). A STRICTLY WORSE basis
 *     than the one recorded in the row's own provenance is refused
 *     (`BASIS_DOWNGRADE`). Equal basis is a genuine revision and still writes;
 *     a BETTER basis is the upgrade path (a standalone-derived row corrected by
 *     a later consolidated filing) and must keep writing, or the guard would
 *     freeze exactly the rows it is meant to protect.
 *  2. **Cross-source displacement** (TICKERTAPE / SCREENER / YAHOO incumbent).
 *     A non-consolidated winner may NOT displace it at all
 *     (`STANDALONE_NO_DISPLACE`) — the founder decision for MONEY-1235.
 *     3,208 of 10,879 winner periods (29.5%) have only standalone XBRL, while
 *     the vendor row is typically consolidated, so writing standalone over it
 *     puts us in disagreement with every other site for a third of the
 *     universe: 360ONE FY2025 totalAssets is 19,768 Cr at the vendor against
 *     our standalone 7,332 Cr. A STANDALONE winner may still CREATE where no
 *     row exists — standalone beats nothing.
 *
 * ## The guards read `rawData` FIRST, and the `basis` COLUMN only as a fallback
 *
 * `rawData.xbrl.filing.basis` stays primary. It is ABSENT on every pre-existing
 * Mongo row — a `db push` creates indexes, not fields — so a guard keyed on the
 * COLUMN alone would be inert for precisely the population it protects, and
 * would read "unknown basis" for rows whose provenance is right there in
 * `rawData`. Basis has been stored in `rawData.xbrl.filing.basis` since the
 * first projection write, which is why this works before anyone runs
 * `db push`.
 *
 * MONEY-1238 adds the column BEHIND it, and only behind it. The
 * BASIS_DOWNGRADE arm below leaves a row of ours writable when its provenance
 * is unreadable, on the grounds that "unknown is not evidence of a better
 * basis" — true of a missing `rawData`, false when the column says
 * CONSOLIDATED. The fallback closes that one case and nothing else: absent on
 * both, the rank is UNKNOWN and no write is refused, which is what an absence
 * of evidence has to do. Before this the column was written twice per write and
 * read nowhere. See {@link IncumbentFinancialsRow.basis}.
 */
export function planFinancialsWrite(opts: {
  projected: ProjectedFinancials;
  incumbent: IncumbentFinancialsRow | null;
  /** Provenance stored alongside the values. */
  filing: ProjectionRawData["xbrl"]["filing"];
  /**
   * What the filing could not fill, from `ProjectionResult.unfilled`.
   *
   * Accepts BOTH the rich entries and bare field names — MONEY-1238. The rich
   * form is what {@link projectFinancials} produces and what a caller should
   * pass; the bare form stays accepted so a caller holding only names (the F3
   * reconcile) is not forced to invent a `needed` list it does not have. A bare
   * name stores `{ field }` with NO `needed`, which reads as "not recorded" —
   * never as "nothing was needed".
   */
  unfilled?: ReadonlyArray<
    string | { field: string; needed?: readonly string[] }
  >;
  now: Date;
  challenger?: FinancialsSource;
}): FinancialsWritePlan {
  const challenger = opts.challenger ?? XBRL_SOURCE;
  // `fields` is every OWNED column — what the displacement record must capture.
  // `writable` is what THIS filing's family lets us write. For a lender the two
  // differ by `operatingIncome` and `ebitda`; see LENDER_UNWRITABLE_FIELDS.
  const fields = ownedFields(opts.projected.statementType);
  const writable = writableFields(
    opts.projected.statementType,
    opts.filing.family as XbrlFinancials["family"],
    opts.filing.filerShape,
  );
  const values = projectedValues(opts.projected, writable);

  const rawData: ProjectionRawData = {
    xbrl: {
      filing: opts.filing,
      projected: opts.projected,
      unfilled: (opts.unfilled ?? []).map((u) =>
        typeof u === "string"
          ? { field: u }
          : u.needed === undefined
            ? { field: u.field }
            : { field: u.field, needed: [...u.needed] },
      ),
    },
  };

  const decision = chooseAuthority(challenger, opts.incumbent?.source ?? null);
  if (decision.keepIncumbent) {
    return {
      action: "SKIP",
      skipReason: "AUTHORITY",
      reason:
        `incumbent source ${String(opts.incumbent?.source)} outranks ` +
        `${challenger} in FINANCIALS_AUTHORITY`,
    };
  }

  const prior = existingDisplacement(opts.incumbent?.rawData);
  // `chooseAuthority` returns the incumbent as `displaced` on an EQUAL-rank
  // refresh too. A source replacing itself has displaced nothing.
  const isRefresh = decision.displaced === challenger;

  // ── The basis guards (MONEY-1235) — see this function's header ──
  const ourBasis = basisRank(opts.filing.basis);
  const stored = storedProvenance(opts.incumbent?.rawData);
  // `rawData` provenance FIRST, the column second — see
  // {@link IncumbentFinancialsRow.basis}. Both absent ranks last and refuses
  // nothing, which is what an absence of evidence has to do here.
  const incumbentBasis = stored?.basis ?? opts.incumbent?.basis ?? null;

  if (isRefresh) {
    // A row of OURS with no basis evidence AT ALL is deliberately left
    // writable: it was written by something older or by hand, and freezing it
    // would be permanent (`re-writes a row of ours that carries no provenance
    // at all`). "Unknown" is not evidence of a better basis — but the `basis`
    // COLUMN is, and it is consulted before we conclude we know nothing.
    if (incumbentBasis !== null && ourBasis > basisRank(incumbentBasis)) {
      return {
        action: "SKIP",
        skipReason: "BASIS_DOWNGRADE",
        reason:
          `this row was projected from a ${String(incumbentBasis)} filing; ` +
          `${String(opts.filing.basis)} would be a downgrade`,
      };
    }
  } else if (
    decision.displaced !== null &&
    ourBasis > basisRank("CONSOLIDATED")
  ) {
    // Anything that is not CONSOLIDATED, not just STANDALONE: an unrecognised
    // basis ranks below standalone and has even less claim to replace a vendor
    // row we can still see. The reason keeps the STANDALONE name because that
    // is the population it was decided for — 29.5% of winner periods.
    return {
      action: "SKIP",
      skipReason: "STANDALONE_NO_DISPLACE",
      reason:
        `a ${String(opts.filing.basis)} filing may not displace ` +
        `${String(decision.displaced)}, which reports the group`,
    };
  }

  // ── CREATE, and it sits BELOW the basis guards on purpose — MONEY-1238 ──
  //
  // It used to be the FIRST branch in the function, which was correct by
  // accident and only for as long as the guard set stayed exactly two. With no
  // incumbent, `chooseAuthority` returns `displaced: null` / `keepIncumbent:
  // false`, `storedProvenance(undefined)` is null and `isRefresh` is false — so
  // every check above is PROVABLY inert on this path and the reorder changes no
  // outcome today (asserted in `xbrl-projection-write.test.ts`: a STANDALONE
  // filing with no incumbent still CREATEs).
  //
  // What it buys is that the next guard added above cannot be bypassed by a row
  // that happens not to exist yet. That is not hypothetical here: the quarterly
  // drain makes EVERY quarterly write a create (71,450 QUARTERLY filings
  // against zero quarterly `stock_financials` rows), so the create path is
  // about to become the MAJORITY path, and a guard the majority path skips is
  // not a guard. The early return placed one branch out of reach of every rule
  // written after it, purely by textual position.
  if (opts.incumbent === null) {
    return {
      action: "CREATE",
      reason: "no incumbent row for this period",
      values,
      source: challenger,
      rawData,
      displaced: null,
    };
  }

  const displaced: DisplacementRecord | null =
    isRefresh || decision.displaced === null
      ? null
      : {
          displacedSource: decision.displaced,
          by: challenger,
          displacedAt: opts.now.toISOString(),
          values: incumbentValues(opts.incumbent, fields),
          fetchedAt: isoOrNull(opts.incumbent.fetchedAt),
          rawData: opts.incumbent.rawData ?? null,
        };

  // First displacement wins. A later one would be recording the state THIS
  // writer created, and would overwrite the only copy of what was there before.
  const keep = prior ?? displaced;
  if (keep) rawData.displacedByXbrl = keep;

  // "Already current" needs all three of: our stamp, our numbers, and OUR
  // filing. Source alone is not enough — a row we wrote from a filing NSE has
  // since corrected would otherwise keep the superseded provenance forever,
  // and the numbers can be identical across a correction.
  //
  // Note that `source === challenger` already implies `displaced === null`
  // (equal rank is the refresh branch), so a pending displacement record cannot
  // be missed here: there is never one to write.
  const unchanged =
    opts.incumbent.source === challenger &&
    // Compared over the WRITABLE columns only: a column we never write cannot
    // be a reason to write. Comparing over all owned fields would see the
    // vendor's `operatingIncome` against our absent one, call every lender row
    // changed, and rewrite it nightly forever.
    sameValues(incumbentValues(opts.incumbent, writable), values) &&
    sameProvenance(stored, opts.filing);
  if (unchanged) {
    return {
      action: "SKIP",
      skipReason: "UNCHANGED",
      reason: "already current — nothing would change",
    };
  }

  return {
    action: "UPDATE",
    reason: isRefresh
      ? "refreshing our own earlier projection"
      : `displacing ${String(decision.displaced)}`,
    values,
    source: challenger,
    rawData,
    displaced,
  };
}

/** Percentage change, undefined unless the base is strictly positive. */
export function growthPct(
  current: number | undefined,
  base: number | undefined,
): number | undefined {
  if (current === undefined || base === undefined) return undefined;
  if (!Number.isFinite(current) || !Number.isFinite(base)) return undefined;
  if (base <= 0) return undefined;
  const g = ((current - base) / base) * 100;
  return Number.isFinite(g) ? g : undefined;
}

// ─── Reconciliation ──────────────────────────────────────────────────

/**
 * How our value relates to the incumbent's. A ladder, not a boolean, because
 * the four cases need four different responses.
 */
export type ReconcileVerdict =
  /** Within tolerance. Rounding, unit granularity, a restated paisa. */
  | "MATCH"
  /** Off by a power of ten or a lakh/crore factor. A UNITS bug on one side. */
  | "SCALE_MISMATCH"
  /** Opposite signs. Usually discontinued operations or a loss convention. */
  | "SIGN_MISMATCH"
  /** Materially different, not explained by scale or sign. Needs a human. */
  | "DISAGREEMENT"
  /** One side has no value. Not a disagreement — nothing to compare. */
  | "INCOMPARABLE";

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  /** Relative difference, |a-b| / |b|. Undefined when INCOMPARABLE. */
  relativeDiff?: number;
  /** For SCALE_MISMATCH: the power-of-ten factor observed (e.g. 100). */
  scaleFactor?: number;
}

/** Factors worth naming: lakh↔crore is 100, and plain powers of ten. */
const KNOWN_SCALES = [10, 100, 1000, 10_000, 100_000, 1e6, 1e7];

/**
 * Compare our figure against the incumbent's.
 *
 * `tolerance` defaults to 1%, which is deliberately loose: filings are reported
 * in ₹ lakh or ₹ crore with two decimals, vendors round differently, and a
 * tighter bar would classify pure presentation as disagreement. The point of
 * this function is to surface the differences a human must look at, and a
 * report that flags 4,000 rounding artefacts surfaces nothing at all.
 */
export function reconcile(
  ours: number | undefined,
  theirs: number | undefined,
  opts?: { tolerance?: number; absoluteEpsilon?: number },
): ReconcileResult {
  if (
    ours === undefined ||
    theirs === undefined ||
    !Number.isFinite(ours) ||
    !Number.isFinite(theirs)
  ) {
    return { verdict: "INCOMPARABLE" };
  }
  const tolerance = opts?.tolerance ?? 0.01;
  // Defaults to 0 — OFF unless a caller opts in — because this function is
  // unit-agnostic and only the caller knows what "negligible" means in the unit
  // it is comparing. MONEY-1234.
  const absoluteEpsilon = opts?.absoluteEpsilon ?? 0;

  if (ours === 0 && theirs === 0) {
    return { verdict: "MATCH", relativeDiff: 0 };
  }

  // A NOISE FLOOR, checked before the relative ladder — MONEY-1234.
  //
  // Relative tolerance alone makes every near-zero value a coin flip. Measured
  // on prod: 3PLAND FY2021 netIncome, ours −0.136 vs theirs −0.12 crore, is a
  // 13% relative difference on an ABSOLUTE gap of ₹16,000. The vendor rounds to
  // two decimals of a crore and we carry full precision, so that gap is pure
  // representation. Reported as a DISAGREEMENT it is worse than noise: it
  // competes for attention with real defects, and a report that flags rounding
  // artefacts surfaces nothing — which is what the docstring above already says
  // this function exists to prevent.
  //
  // Placed here so it also covers the one-sided-zero case below: 0 vs 0.0001 is
  // not a disagreement about the world either.
  if (absoluteEpsilon > 0 && Math.abs(ours - theirs) <= absoluteEpsilon) {
    return {
      verdict: "MATCH",
      ...(theirs === 0
        ? {}
        : { relativeDiff: Math.abs(ours - theirs) / Math.abs(theirs) }),
    };
  }
  // A zero on exactly one side cannot be scaled or signed into agreement, and
  // dividing by it would be the non-finite bug this module exists to avoid.
  //
  // `relativeDiff` is OMITTED rather than set to Infinity. An earlier version
  // returned Infinity here, which is the very defect class this module guards
  // at every other boundary: it flows into a sort and pins the row to one end,
  // into an average and destroys it, and into a `toFixed` and prints "Infinity"
  // to a reader. "There is no meaningful relative difference" is exactly what
  // an absent field says.
  if (theirs === 0 || ours === 0) {
    return { verdict: "DISAGREEMENT" };
  }

  const relativeDiff = Math.abs(ours - theirs) / Math.abs(theirs);
  if (relativeDiff <= tolerance) return { verdict: "MATCH", relativeDiff };

  // Sign is checked BEFORE scale, and it wins even when a scale factor is ALSO
  // present. A value that is both flipped and 100x off has two problems, and
  // the sign is the semantic one — reporting it as SCALE_MISMATCH sends the
  // reader hunting a units bug and leaves the sign error to be discovered later.
  //
  // The magnitude test therefore allows a known scale factor: signs differing
  // while |ours| matches |theirs| AT SOME factor is still a sign problem.
  // (An earlier version compared magnitudes at factor 1 only, so a
  // flipped-and-scaled value fell through to DISAGREEMENT — contradicting this
  // very comment.)
  if (Math.sign(ours) !== Math.sign(theirs)) {
    const magnitudesAgree = [1, ...KNOWN_SCALES].some((factor) =>
      [Math.abs(ours) / factor, Math.abs(ours) * factor].some(
        (candidate) =>
          Math.abs(candidate - Math.abs(theirs)) / Math.abs(theirs) <=
          tolerance,
      ),
    );
    if (magnitudesAgree) {
      return { verdict: "SIGN_MISMATCH", relativeDiff };
    }
    return { verdict: "DISAGREEMENT", relativeDiff };
  }

  for (const factor of KNOWN_SCALES) {
    for (const candidate of [ours / factor, ours * factor]) {
      if (Math.abs(candidate - theirs) / Math.abs(theirs) <= tolerance) {
        return { verdict: "SCALE_MISMATCH", relativeDiff, scaleFactor: factor };
      }
    }
  }

  return { verdict: "DISAGREEMENT", relativeDiff };
}

/**
 * Is the XBRL source ready to become authoritative for a symbol?
 *
 * The gate P10 F3's switchover turns on. Two properties, and the second is the
 * one that matters:
 *
 *   1. Enough periods reconciled to be worth a judgement at all.
 *   2. The DISAGREEMENT rate — not the match rate. SCALE_MISMATCH and
 *      SIGN_MISMATCH are excluded from the numerator because they are OUR bugs
 *      and are fixable; counting them as "not matching" would keep the gate
 *      shut on problems that a units fix resolves, and counting them as
 *      matching would ship them.
 *
 * ## The denominator, which this got WRONG the first time
 *
 * An earlier version computed `disagreements / compared` where `compared`
 * counted INCOMPARABLE pairs too, under a comment claiming that made a
 * data-poor source unable to pass. It does the exact OPPOSITE: every blank
 * INFLATES the denominator and DILUTES the failure rate, so padding a bad
 * source with rows it has no value for OPENS the gate. Measured on the test
 * that caught it: 3 disagreements in 5 usable comparisons is a 60% failure
 * rate, but padded with 95 blanks it reads as 3.0% and passes.
 *
 * That is the MONEY-1196 defect, written into the function whose own comment
 * warned about it. So there are now TWO independent requirements, because one
 * number cannot express both:
 *
 *   1. `minComparable` — enough pairs where BOTH sides had a value. This is
 *      what stops a source that mostly has no data.
 *   2. the disagreement rate over COMPARABLE pairs only — blanks cannot dilute
 *      it, because they are not in it.
 */
export interface SwitchoverReadiness {
  ready: boolean;
  reason: string;
  /** Every pair examined, blanks included. */
  compared: number;
  /**
   * Pairs where BOTH sides had a value — the real base for the rate. Exposed
   * because `compared` on its own reads as the denominator and is not.
   */
  comparable: number;
  matched: number;
  disagreements: number;
  scaleMismatches: number;
  signMismatches: number;
  incomparable: number;
}

/**
 * What the EXCLUDED pairs say about the exclusion itself — MONEY-1249.
 *
 * The F3 reconcile drops standalone-vs-vendor pairs on the theory that they
 * measure a BASIS gap rather than a data-quality one: a holding company's
 * standalone revenue differs from its consolidated by a MULTIPLE. If that theory
 * holds, the excluded rows should disagree MORE than the survivors and removing
 * them should drop the rate materially. If they disagree no more, the exclusion
 * bought a SMALLER sample rather than a cleaner one — which changes what arming
 * means, so the gate says it out loud.
 *
 * ## Why this is a function and not two lines at the call site
 *
 * It was two lines at the call site, and they compared a FRACTION against a
 * PERCENTAGE:
 *
 *     rate         = (disagreements / comparable) * 100   // 8.0
 *     excludedRate =  disagree / comparable               // 0.143
 *     if (excludedRate <= rate)                           // always true
 *
 * So the refutation printed on every field regardless of direction. Measured on
 * prod 2026-08-22 it fired on `netIncome` (14.3% vs 8.0%), `totalAssets` (23.3%
 * vs 13.4%) and `totalEquity` (13.3% vs 6.2%) — three fields where the basis
 * hypothesis is SUPPORTED — and told the reader it was refuted, in the sentence
 * read immediately before arming a one-way door.
 *
 * Both inputs are PERCENTAGES (0-100). A caller passing a fraction gets a
 * `verdict` of `"UNDERSIZED"` for anything under 20 comparable pairs and
 * otherwise a wrong-but-typed answer, so the units are asserted by the tests
 * rather than by hope.
 */
export type ExclusionComparison =
  | { verdict: "UNDERSIZED"; excludedRatePct: number }
  | { verdict: "BASIS_HYPOTHESIS_HOLDS"; excludedRatePct: number }
  | { verdict: "BASIS_HYPOTHESIS_REFUTED"; excludedRatePct: number };

/** Below this many excluded pairs the comparison is noise, not evidence. */
export const EXCLUSION_COMPARISON_MIN_PAIRS = 20;

export function judgeExclusionComparison(args: {
  /** Excluded pairs that were comparable. */
  excludedComparable: number;
  /** Of those, how many disagreed. */
  excludedDisagree: number;
  /** The GRADED disagreement rate, as a PERCENTAGE (0-100). */
  gradedRatePct: number;
  minPairs?: number;
}): ExclusionComparison {
  const { excludedComparable, excludedDisagree, gradedRatePct } = args;
  const minPairs = args.minPairs ?? EXCLUSION_COMPARISON_MIN_PAIRS;
  const excludedRatePct =
    excludedComparable > 0 ? (excludedDisagree / excludedComparable) * 100 : 0;

  if (excludedComparable < minPairs) {
    return { verdict: "UNDERSIZED", excludedRatePct };
  }
  // Strictly greater: an excluded rate ABOVE the graded one is the shape the
  // basis hypothesis predicts, so the hypothesis HOLDS and nothing is refuted.
  return excludedRatePct > gradedRatePct
    ? { verdict: "BASIS_HYPOTHESIS_HOLDS", excludedRatePct }
    : { verdict: "BASIS_HYPOTHESIS_REFUTED", excludedRatePct };
}

/**
 * One field's DECLARED definitional divergence — MONEY-1255.
 *
 * Two strings, not one, and the split is the whole point. `reason` says WHAT
 * the two sides mean; `evidence` says HOW WE KNOW, with numbers. A declaration
 * carrying only the first is indistinguishable from an opinion, and this is the
 * instrument that stops a field blocking a one-way door.
 */
export interface DeclaredDivergence {
  /** What the two columns MEAN, and why the difference is definitional. */
  reason: string;
  /** The measurement that establishes it. Printed verbatim, never summarised. */
  evidence: string;
}

/**
 * What the F3 gate says about ONE field — MONEY-1255.
 *
 *   READY        the ladder cleared it on its own evidence.
 *   BLOCKED      the ladder faulted it. The only verdict that holds the door.
 *   UNVERIFIABLE the incumbent has NO value anywhere, so there is nothing to
 *                compare and nothing for the write to destroy (MONEY-1250).
 *   DECLARED     the two sides are DIFFERENT QUANTITIES by a difference we
 *                understand and have written down. Neither a pass nor a fail.
 */
export type FieldGateVerdict =
  | "READY"
  | "BLOCKED"
  | "UNVERIFIABLE"
  | "DECLARED";

export interface FieldGateOutcome {
  verdict: FieldGateVerdict;
  /** Whether this field holds the switchover shut. ONLY `BLOCKED` does. */
  blocks: boolean;
  /**
   * Set when a DECLARED field had nothing to declare a divergence ABOUT.
   *
   * A declaration asserts "we measured a gap and it is definitional". With zero
   * comparable pairs no gap was measured on this run, so the declaration is
   * UNTESTED here — still not blocking, but the reader must not take the
   * printed evidence as this run's finding. Absence of this note is itself
   * information: it means the declaration was exercised.
   */
  declarationUntested?: true;
}

/**
 * Fold one field's ladder result, its incumbent coverage and its declaration
 * into a single verdict — MONEY-1255.
 *
 * ## Why this is a function rather than three conditions at the call site
 *
 * It was two conditions at the call site (`ready`, `unverifiable`) and the
 * PRECEDENCE between them was implicit in the order they were written. Adding a
 * third state to that shape is how the ratios gate ended up unpassable: there,
 * vendor-side absence read as a failure for a whole release because "no value"
 * and "wrong value" shared one branch. The three states have to be ordered
 * deliberately, in one place, with the ordering testable.
 *
 * ## The ordering, and why DECLARED is first
 *
 * A declared field is one we have decided not to grade AT ALL. Letting the
 * ladder's own verdict reach the output first would print `BLOCKED` beside a
 * line saying the field does not block — the exact self-contradiction that
 * teaches a reader to skim the verdict line.
 *
 * `UNVERIFIABLE` comes next because it is a statement about the POPULATION (the
 * vendor has nothing) rather than about agreement, and it has to outrank
 * `BLOCKED`, which `judgeSwitchoverReadiness` returns for any field under its
 * comparable floor — including a field with no possible comparisons.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch the EXCLUSION DRAIN (MONEY-1237 item 7). That check needs
 * the excluded population, is about whether a READY still speaks for the rows
 * being written, and withdraws READY rather than replacing it. Folding it in
 * here would put two unrelated policies behind one name.
 *
 * ## The safety of the DECLARED exemption
 *
 * There is none, inherently — a declaration is a decision to carry known risk
 * through a one-way door, and the ONLY thing standing between it and a
 * suppression is that the field keeps printing its full census and its evidence
 * verbatim. That is enforced at the call site, not here; this function's job is
 * to make sure the exemption is never applied by accident, which is why
 * `declared` is a required parameter rather than an optional flag.
 */
export function judgeFieldGateOutcome(args: {
  /** `judgeSwitchoverReadiness(...).ready` for this field. */
  ready: boolean;
  /** Pairs where BOTH sides had a value. */
  comparable: number;
  /** Pairs where at least one side had none. */
  incomparable: number;
  /**
   * GRADED pairs where the INCUMBENT had a value — counted, never inferred
   * from `incomparable`, which cannot say WHICH side was empty. MONEY-1250.
   */
  incumbentValuesSeen: number;
  /** Whether this field carries a `DeclaredDivergence`. */
  declared: boolean;
}): FieldGateOutcome {
  const { ready, comparable, incomparable, incumbentValuesSeen, declared } =
    args;

  if (declared) {
    return {
      verdict: "DECLARED",
      blocks: false,
      ...(comparable === 0 ? { declarationUntested: true as const } : {}),
    };
  }

  // DELIBERATELY NARROW, and all three conjuncts are load-bearing — MONEY-1250.
  // `incomparable > 0` alone cannot separate "the column is NEW" from "the
  // writer CANNOT FILL a column the vendor populated", and only the first is
  // safe to exempt. Asking whether the incumbent has ANY value answers it
  // directly.
  if (comparable === 0 && incomparable > 0 && incumbentValuesSeen === 0) {
    return { verdict: "UNVERIFIABLE", blocks: false };
  }

  return ready
    ? { verdict: "READY", blocks: false }
    : { verdict: "BLOCKED", blocks: true };
}

/** What one excluded SYMBOL removed from the ladder — MONEY-1255. */
export interface SymbolExclusionTally {
  symbol: string;
  /** Every comparison removed, blanks included. */
  total: number;
  /** Of those, pairs where BOTH sides had a value — the rate's denominator. */
  comparable: number;
  /** The verdicts the removal HID. These are the reason the exclusion exists. */
  scale: number;
  sign: number;
  disagree: number;
  matched: number;
  incomparable: number;
  /** Which columns it touched, sorted, so the claim is checkable per column. */
  fields: string[];
}

/**
 * Account for a symbol exclusion, INCLUDING the ones that removed nothing —
 * MONEY-1255.
 *
 * ## Why every declared symbol gets a row even at zero
 *
 * Because a silent exclusion is how a gate lies, and the silence that matters
 * most is the one where the exclusion was WRONG. A symbol that removes no
 * blocker is either (a) already excluded by something upstream — the quarantine
 * or a planner skip — in which case naming it here overstates what the
 * exclusion bought, or (b) not actually a problem for THIS gate, in which case
 * it should not be on the list at all. Both are invisible if the tally only
 * lists symbols it found rows for.
 *
 * `MODIRUBBER, OPTIEMUS, CENTUM, DVL` is the live case, and it has already paid
 * for itself. On the prod run of 2026-08-26 the first two carry the only two
 * surviving `SIGN_MISMATCH` rows on the whole ladder (and MODIRUBBER one of
 * seven surviving `SCALE_MISMATCH`), while the second two appear NOWHERE in the
 * financials reconcile's output — their two `SIGN_MISMATCH` verdicts are in the
 * SIBLING ratios gate, on `roe`. A tally that skipped empty rows would have
 * printed two symbols and let the other two look equally load-bearing.
 *
 * The zero rows are what got CENTUM and DVL MOVED: they are now declared in
 * `xbrl-ratios-validate.ts`, the gate whose verdict they actually change, and
 * the financials list is back to two. This function is used by BOTH gates for
 * exactly that reason — a symbol excluded in one is not thereby excluded in the
 * other, and each list has to justify itself against its own population.
 *
 * Pure, and deliberately typed on the narrowest row shape that answers the
 * question, so the reconcile's `Comparison` can grow without touching this.
 */
export function tallySymbolExclusions(
  rows: ReadonlyArray<{
    symbol: string;
    field: string;
    verdict: ReconcileVerdict;
  }>,
  symbols: readonly string[],
): SymbolExclusionTally[] {
  const empty = (symbol: string): SymbolExclusionTally => ({
    symbol,
    total: 0,
    comparable: 0,
    scale: 0,
    sign: 0,
    disagree: 0,
    matched: 0,
    incomparable: 0,
    fields: [],
  });

  // Seeded from the DECLARED list, not from the rows — that is what makes a
  // zero appear. Order follows the declaration so the printed block reads in
  // the order the list is written and maintained in.
  const out = new Map<string, SymbolExclusionTally>();
  const fields = new Map<string, Set<string>>();
  for (const s of symbols) {
    if (!out.has(s)) {
      out.set(s, empty(s));
      fields.set(s, new Set<string>());
    }
  }

  for (const r of rows) {
    const t = out.get(r.symbol);
    if (t === undefined) continue; // not a declared exclusion; not ours to count
    t.total++;
    fields.get(r.symbol)?.add(r.field);
    switch (r.verdict) {
      case "INCOMPARABLE":
        t.incomparable++;
        break;
      case "SCALE_MISMATCH":
        t.scale++;
        t.comparable++;
        break;
      case "SIGN_MISMATCH":
        t.sign++;
        t.comparable++;
        break;
      case "DISAGREEMENT":
        t.disagree++;
        t.comparable++;
        break;
      case "MATCH":
        t.matched++;
        t.comparable++;
        break;
    }
  }

  for (const [symbol, set] of fields) {
    const t = out.get(symbol);
    if (t) t.fields = [...set].sort();
  }
  return [...out.values()];
}

/**
 * WHICH SIDE of an INCOMPARABLE pair was empty — MONEY-1250.
 *
 * ## The question the ladder cannot answer, and why it matters here
 *
 * `INCOMPARABLE` means one side had no value. It does not say which, and the
 * two readings call for opposite responses:
 *
 *     ours present, theirs absent   the column is NEW        -> a coverage WIN
 *     ours ABSENT,  theirs present  we cannot fill it        -> a coverage GAP
 *
 * `judgeSwitchoverReadiness` folds both into one `incomparable` count, and
 * INCOMPARABLE is outside the disagreement rate by design (MONEY-1196), so a
 * field can read `comparable 2555 of 4744` with nothing anywhere saying what
 * the other 2,189 were. Measured on prod 2026-08-24, that shortfall is 2,165
 * OURS-BLANK, 19 THEIRS-BLANK and 5 BOTH-BLANK on every balance-sheet field —
 * i.e. essentially all of it is ground WE do not cover, and a reader had no way
 * to tell that from the gate's own output.
 *
 * The `unverifiable` exemption already needed this distinction and solved it
 * for ONE field by counting incumbent values separately. This generalises that
 * count instead of leaving five other fields to be guessed at.
 *
 * ## Why BOTH_BLANK is its own bucket
 *
 * A naive `ours === undefined ? "OURS_BLANK" : "THEIRS_BLANK"` attributes a
 * pair where NEITHER side has a value to us. That pair is not a gap on our side
 * — there is nothing to be missing against — and counting it as one inflates
 * exactly the number this function exists to make honest.
 *
 * `COMPARABLE` is returned for a pair where both sides have a value, so a
 * caller cannot silently feed graded pairs in and have them counted as blanks.
 * `NaN`/`Infinity` count as ABSENT: they are not values a comparison can use,
 * and the standing rule in this repo is that non-finite money is poison rather
 * than a number (MONEY-1175 and every `finite()` guard since).
 */
export type IncomparableSide =
  | "OURS_BLANK"
  | "THEIRS_BLANK"
  | "BOTH_BLANK"
  | "COMPARABLE";

export function classifyIncomparable(pair: {
  ours: number | null | undefined;
  theirs: number | null | undefined;
}): IncomparableSide {
  const has = (v: number | null | undefined): boolean =>
    typeof v === "number" && Number.isFinite(v);
  const ours = has(pair.ours);
  const theirs = has(pair.theirs);
  if (ours && theirs) return "COMPARABLE";
  if (!ours && !theirs) return "BOTH_BLANK";
  return ours ? "THEIRS_BLANK" : "OURS_BLANK";
}

export interface IncomparableSplit {
  /** We have no value and the vendor does — a coverage GAP on our side. */
  oursBlank: number;
  /** We have a value and the vendor does not — a coverage WIN. */
  theirsBlank: number;
  /** Neither side has a value. Not a gap in either direction. */
  bothBlank: number;
  /** Pairs that were not incomparable at all. Should be zero for a caller
   *  that has already filtered on the verdict; counted rather than dropped so
   *  a mis-filtered caller is visible instead of quietly rescaling the split. */
  comparable: number;
}

/**
 * Split a set of pairs by which side was empty. See {@link classifyIncomparable}.
 */
export function splitIncomparable(
  pairs: ReadonlyArray<{
    ours: number | null | undefined;
    theirs: number | null | undefined;
  }>,
): IncomparableSplit {
  const out: IncomparableSplit = {
    oursBlank: 0,
    theirsBlank: 0,
    bothBlank: 0,
    comparable: 0,
  };
  for (const p of pairs) {
    switch (classifyIncomparable(p)) {
      case "OURS_BLANK":
        out.oursBlank++;
        break;
      case "THEIRS_BLANK":
        out.theirsBlank++;
        break;
      case "BOTH_BLANK":
        out.bothBlank++;
        break;
      case "COMPARABLE":
        out.comparable++;
        break;
    }
  }
  return out;
}

export function judgeSwitchoverReadiness(
  verdicts: readonly ReconcileVerdict[],
  opts?: {
    /** Minimum pairs where BOTH sides had a value. Blanks do not count. */
    minComparable?: number;
    maxDisagreementRate?: number;
    /**
     * Deprecated alias for `minComparable`, kept so an existing caller does not
     * silently lose its threshold. It now means what it always should have.
     */
    minCompared?: number;
  },
): SwitchoverReadiness {
  const minComparable = opts?.minComparable ?? opts?.minCompared ?? 20;
  const maxDisagreementRate = opts?.maxDisagreementRate ?? 0.05;

  const compared = verdicts.length;
  const matched = verdicts.filter((v) => v === "MATCH").length;
  const disagreements = verdicts.filter((v) => v === "DISAGREEMENT").length;
  const scaleMismatches = verdicts.filter((v) => v === "SCALE_MISMATCH").length;
  const signMismatches = verdicts.filter((v) => v === "SIGN_MISMATCH").length;
  const incomparable = verdicts.filter((v) => v === "INCOMPARABLE").length;

  const base = {
    compared,
    comparable: compared - incomparable,
    matched,
    disagreements,
    scaleMismatches,
    signMismatches,
    incomparable,
  };

  // COMPARABLE, not `compared`. A pair where one side had no value tells us
  // nothing about agreement, so it can neither support the gate nor dilute it.
  const comparable = compared - incomparable;
  if (comparable < minComparable) {
    return {
      ...base,
      ready: false,
      reason:
        `only ${comparable} COMPARABLE pair(s) out of ${compared} ` +
        `(${incomparable} had no value on one side); need at least ` +
        `${minComparable} before this means anything`,
    };
  }
  // Any units or sign bug blocks outright rather than counting toward a rate.
  // Both are systematic — one occurrence implies a whole class of periods is
  // wrong — so a percentage threshold is the wrong instrument for them.
  if (scaleMismatches > 0) {
    return {
      ...base,
      ready: false,
      reason: `${scaleMismatches} SCALE mismatch(es) — a units bug on one side; fix it, do not average it away`,
    };
  }
  if (signMismatches > 0) {
    return {
      ...base,
      ready: false,
      reason: `${signMismatches} SIGN mismatch(es) — usually a discontinued-operations or loss-convention difference; resolve it explicitly`,
    };
  }
  // Over COMPARABLE pairs. `comparable` is >= minComparable >= 1 here, so this
  // cannot divide by zero.
  const rate = disagreements / comparable;
  if (rate > maxDisagreementRate) {
    return {
      ...base,
      ready: false,
      reason:
        `disagreement rate ${(rate * 100).toFixed(1)}% ` +
        `(${disagreements}/${comparable} comparable) exceeds ` +
        `${(maxDisagreementRate * 100).toFixed(1)}%`,
    };
  }
  return {
    ...base,
    ready: true,
    reason:
      `${matched}/${comparable} comparable matched, ${disagreements} ` +
      `disagreement(s) (${(rate * 100).toFixed(1)}%), no scale or sign errors` +
      `${incomparable ? `; ${incomparable} pair(s) had no value on one side and were excluded` : ""}`,
  };
}
