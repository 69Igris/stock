/**
 * XBRL vs Tickertape reconciliation — MONEY-1115 (Data Engine P10 F3).
 *
 * READ-ONLY. Writes nothing, ever. It answers one question with evidence:
 * "is `XbrlFiling` good enough to become the authoritative source for
 * `StockFinancials`, and if not, exactly where does it disagree?"
 *
 * ## Why this exists as its own step
 *
 * The switchover is the risky half of P10. `StockFinancials` has no `source` in
 * its unique key, so once XBRL starts writing it, the Tickertape value for that
 * period is gone — there is no second copy to compare against afterwards. The
 * reconciliation has to happen BEFORE the first write, or it cannot happen at
 * all.
 *
 * That is also why `XbrlFiling` is a separate table rather than more rows in
 * `StockFinancials`: keeping the filing raw is what makes both values exist at
 * the same time.
 *
 * ## Why a VERDICT LADDER and not a match percentage
 *
 * A single "87% match" cannot be acted on. The four ways two financial figures
 * differ need four different responses:
 *
 *   MATCH            within tolerance — rounding, ₹ lakh vs ₹ crore precision
 *   TRANSLATED       the raw figures differ, but ours PLUS the vendor's own
 *                    declared extra term agrees within the same tolerance. A
 *                    definitional gap, not a data gap: their `revenue` is TOTAL
 *                    INCOME and their `operatingIncome` is EBIT INCLUDING other
 *                    income, while ours are operations-only. Reported as its own
 *                    bucket and never folded into MATCH — see the DECLARED
 *                    TRANSLATION section below (MONEY-1239).
 *   SCALE_MISMATCH   off by a power of ten — a UNITS bug on one side. One
 *                    occurrence implies a whole class of periods is wrong, so
 *                    it BLOCKS rather than counting toward a rate.
 *   SIGN_MISMATCH    opposite signs — discontinued operations, or a loss
 *                    convention. Also systematic, also blocks.
 *   DISAGREEMENT     materially different, not explained by scale or sign.
 *                    This is the only one a rate threshold is appropriate for.
 *   INCOMPARABLE     one side has no value. NOT a disagreement — but it counts
 *                    toward the population, so a source that mostly has no data
 *                    cannot pass by comparing the handful it does have. That
 *                    draining-denominator failure is MONEY-1196 exactly.
 *
 * The judgement lives in `@usemoney/core/market-data` (pure, unit-tested); this
 * script is the I/O harness that feeds it.
 *
 * ## The DECLARED TRANSLATION, and why it is a bucket rather than a match
 *
 * MONEY-1239. Our projection is CORRECT and the gate was blocking anyway.
 * Adjudicated against screener.in as a third source: 3MINDIA reconciles 12/12 to
 * the rupee against screener's CONSOLIDATED over FY2021-23 x {revenue,
 * netIncome, operatingIncome, ebitda}, while the vendor matches screener's
 * STANDALONE. The two sides agree about the FACTS and disagree about exactly one
 * line item — OTHER INCOME — which the vendor folds into `revenue` and into
 * `operatingIncome` and we do not.
 *
 * Measured on prod, 7,167 comparisons, relative-difference percentiles:
 *
 *   field              n     p50     p75     p90     p95     p99   within 1%
 *   revenue          2442   2.19%   6.93%  21.95%  51.00%  95.53%    29.7%
 *   netIncome        2443   0.01%   0.14%   3.20%  19.54%  99.43%    86.9%
 *   operatingIncome  2282  17.16%  41.54%  91.07% 117.46% 163.32%     3.0%
 *
 * Three magnitudes, ONE phenomenon: the same absolute other-income amount over
 * three different denominators. `netIncome` agrees because there is no gap
 * there — both sides mean profit attributable to owners — which is why it is
 * deliberately NOT translated. A translation on `netIncome` could only ever fire
 * on a pair that is genuinely wrong.
 *
 * Three properties keep this from being "widen the tolerance until it passes":
 *
 *  1. The extra term is READ OFF THE SAME FILING (`otherIncome`). Fitting a
 *     constant X such that `ours + X == theirs` proves nothing and is forbidden.
 *  2. Absent `otherIncome`, the pair CANNOT be translated and is counted
 *     `translationUnavailable` — a separate value from a translation that was
 *     tried and failed. It still counts as a disagreement.
 *  3. TRANSLATED is COUNTED AND PRINTED per field, and the report gives the
 *     disagreement rate BOTH ways — with translations as matches (what the
 *     verdict uses) and with them demoted to disagreements — naming which is
 *     which. Whether definitional risk should count toward arming is a founder
 *     decision; this script supplies both numbers and makes neither.
 *
 * ## What the ladder structurally CANNOT see — MONEY-1239
 *
 * A pair where OUR side is blank scores INCOMPARABLE, and INCOMPARABLE is
 * outside the disagreement rate by design (MONEY-1196). So a projection that
 * simply has no value for a column the vendor populated cannot move any rate and
 * cannot block — while the write still lands, because `projectedValues` emits
 * `null` for every OWNED field the projection could not fill. `operatingIncome`
 * is the live case: it needs `operatingProfitBeforeProvisions`, present in 76 of
 * 741 banking and 0 of 206 NBFC ANNUAL filings on prod. The INCUMBENT-NULLING
 * block counts those pairs explicitly, because they are a trade to accept before
 * the one-way door rather than discover behind it.
 *
 * ## What the gate must NOT judge — MONEY-1235
 *
 * A comparison is evidence only if the writer would actually PERFORM the write
 * it describes. Two populations were being graded that the writer never
 * touches, and both pushed the verdict the wrong way:
 *
 *   QUARANTINED             `judgeFilingScale` says this filing's magnitudes
 *                           disagree with the SAME COMPANY's other filings by a
 *                           power of ten, so the writer refuses it outright
 *                           (`refusedScaleSuspect`) and writes nothing, ever.
 *                           The 28 scale mismatches this gate reported on
 *                           2026-08-21 — 1000x:12, 100x:11, 10x:4, 10000x:1,
 *                           across 15 (symbol, period) filings, in BOTH
 *                           directions, each internally consistent across its
 *                           own fields — are filers mis-declaring their own
 *                           `roundingLabel`, not our arithmetic. Blocking on a
 *                           value that will never be written keeps the gate shut
 *                           on a defect the writer already handles.
 *   STANDALONE_NO_DISPLACE  a STANDALONE winner may not displace a vendor
 *                           incumbent. The vendor value SURVIVES, so there is no
 *                           write to judge. 3,208 of 10,879 winner periods
 *                           (29.5%) are standalone-only, and a holding company's
 *                           standalone revenue differs from its consolidated one
 *                           by a MULTIPLE — grading those measured a BASIS
 *                           mismatch and reported it as a data-quality failure.
 *
 * Neither is inferred here. The quarantine calls the same `judgeFilingScale` the
 * writer calls, and the skip comes from `planFinancialsWrite` itself, so "what
 * the gate excludes" and "what the writer refuses" cannot drift apart. A local
 * `basis === "CONSOLIDATED"` in this file would be the third copy of one
 * ordering, and `reconcile-gate-population.test.ts` fails the build for it.
 *
 * ## Excluding is only safe if the exclusion is LOUDER than the verdict
 *
 * Both exclusions are reported per field, on the same line as the surviving
 * comparable count, and a field that reads READY only because its failures were
 * excluded says so in as many words. That is not politeness: MONEY-1196 was a
 * denominator quietly draining until a 60% failure rate read as 3.0%, and this
 * change deliberately drains the denominator. The difference between the fix and
 * the bug is entirely whether the removal is printed.
 *
 * ## Two founder decisions the gate now carries — MONEY-1255
 *
 * Both are ways of NOT BLOCKING on something real, so both are held to the same
 * standard: the run prints the full census either way, prints the reason
 * verbatim, and says in the VERDICT LINE that it did so.
 *
 *   DECLARED DIVERGENCE ({@link DECLARED_FIELD_DIVERGENCES}) — a FIELD whose
 *     two sides are different QUANTITIES by a difference that is definitional,
 *     measured, and not closable from the filings we hold. `totalDebt` is the
 *     one entry: ours is the filing's own funding lines (a four-line sum for an
 *     Ind-AS lender), the vendor's adds Ind-AS 116 lease liabilities, and the
 *     integrated-filing taxonomy publishes no lease-liability balance element
 *     to parse. It grades DECLARED — neither a pass nor a block — and still
 *     prints comparable/matched/disagreed/scale/sign/incomparable.
 *
 *   SYMBOL EXCLUSION ({@link EXCLUDED_SYMBOLS}) — and this one is DIFFERENT IN
 *     KIND from every other exclusion in this file. The others remove rows the
 *     WRITER WILL NOT WRITE, which is what keeps the gate a measurement of the
 *     writer. These rows WILL be written. Excluding them does not improve the
 *     measurement; it agrees to arm over a population already found wrong. It
 *     is printed above the ladder rather than below it, every declared symbol
 *     gets a line INCLUDING the ones that removed nothing, and the removals
 *     flow through the ordinary `excluded` machinery so the existing "READY
 *     RESTS ON THE EXCLUSION" line fires on them automatically.
 *
 * The one thing the symbol list must never do is quiet the INCUMBENT-NULLING
 * count, which is keyed on the WRITER's skip (`writerSkip`) and not on
 * `excluded` for exactly that reason.
 *
 * Usage:
 *   npx tsx scripts/data/xbrl-reconcile.ts                    # whole universe
 *   npx tsx scripts/data/xbrl-reconcile.ts --symbols=TCS,INFY
 *   npx tsx scripts/data/xbrl-reconcile.ts --limit=200 --verbose
 *
 * Prefer the wrapper so DATABASE_URL comes from Secret Manager:
 *   ./scripts/ops/run-market-data-job.sh xbrlrecon prod
 */

import { pathToFileURL } from "node:url";

import prisma, { type Prisma } from "@usemoney/database";
import {
  projectFinancials,
  reconcile,
  judgeSwitchoverReadiness,
  judgeExclusionComparison,
  // MONEY-1255 — the per-field verdict ladder (READY / BLOCKED / UNVERIFIABLE /
  // DECLARED) and the symbol-exclusion accounting. Both live in core so the
  // ORDERING between the verdicts is unit-tested; this file is the I/O harness.
  judgeFieldGateOutcome,
  tallySymbolExclusions,
  type DeclaredDivergence,
  // MONEY-1250 — WHICH SIDE of an INCOMPARABLE pair was empty. Imported rather
  // than counted inline for the reason `judgeExclusionComparison` was extracted:
  // an inline `ours === undefined` branch mis-files a both-blank pair as a gap
  // on our side, and nothing about the resulting number says so.
  splitIncomparable,
  classifyIncomparable,
  // MONEY-1235 — the two decisions that make this gate measure the WRITER
  // rather than a writer that no longer exists. Both are IMPORTED, never
  // restated: `judgeFilingScale` is the same function `xbrl-projection-writer`
  // quarantines on, and `planFinancialsWrite` is the planner it obeys.
  judgeFilingScale,
  planFinancialsWrite,
  ownedFields,
  scaleValuesOf,
  XBRL_SOURCE,
  type ScaleObservation,
  type ScaleJudgement,
  type FinancialsSkipReason,
  type IncumbentFinancialsRow,
  type ProjectedFinancials,
  type ReconcileVerdict,
  type IncomparableSplit,
  type XbrlFinancials,
  rupeesToCrores,
  periodLabel,
  selectFilingForPeriod,
  toCroreDenominated,
  INCOME_FIELDS,
  BALANCE_SHEET_FIELDS,
  // MONEY-1255 — PRINTED VERBATIM by this gate, never restated. The three
  // vendor columns the projection stopped claiming, with the measurement that
  // justified it. A reader of a READY verdict has to be able to see which
  // columns the switchover no longer touches at all.
  UNOWNED_VENDOR_COLUMNS,
  judgeProjectionEligibility,
  writableFields,
  filerShapeOf,
  type FilerShape,
} from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const VERBOSE = argv.includes("--verbose");
const LIMIT = Number(arg("limit") ?? 0) || 0;
const SYMBOLS = (arg("symbols") ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * Is this a NARROWED run? — MONEY-1236.
 *
 * Several checks below assert facts about the FULL prod population ("3,208 of
 * 10,879 winner periods are standalone-only"). Those are not invariants, they
 * are census figures, and a `--symbols=` or `--limit=` run can legitimately
 * contradict every one of them. Tripping on a scoped run makes the gate exit 1
 * with no field actually blocked — which would be exactly the scoped pilot the
 * switchover runbook asks for, permanently red.
 */
const RUN_IS_SCOPED = LIMIT > 0 || SYMBOLS.length > 0;

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-reconcile]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-reconcile]", ...a),
  error: (...a: unknown[]) => console.error("[xbrl-reconcile]", ...a),
};

/**
 * The fields reconciled — DERIVED from what the writer owns, never restated.
 *
 * This list used to be a hand-written six: revenue, netIncome, operatingIncome,
 * ebitda, totalAssets, totalEquity. The writer owns TEN. So `totalDebt`,
 * `totalLiabilities`, `totalCash` and `otherIncome` were written by the
 * projection and never graded by the gate that authorises the projection —
 * while the final line still read "VERDICT: NOT ready over the 24442 GRADED
 * comparison(s)", which a reader can only take to mean the writer's output was
 * what got graded.
 *
 * `stock_financials` holds 9,861 TICKERTAPE `totalDebt` values and the table has
 * no `source` in its unique key, so arming would have destroyed every one of
 * them with no evidence ever collected — the exact one-way door this script
 * exists to hold shut. MONEY-1250.
 *
 * Deriving it removes the drift permanently: a field added to `INCOME_FIELDS` or
 * `BALANCE_SHEET_FIELDS` is graded from that commit, with no second edit to
 * remember. A column the vendor cannot back reads `only N COMPARABLE pair(s) …
 * need at least 20` rather than passing quietly — `judgeSwitchoverReadiness`
 * refuses a vacuous READY, so widening this cannot manufacture a green.
 */
const FIELDS = [...INCOME_FIELDS, ...BALANCE_SHEET_FIELDS] as const;
type Field = (typeof FIELDS)[number];

/**
 * Below this many CRORES apart, two figures are the same figure — MONEY-1234.
 *
 * Everything compared here is in crores, and the vendor rounds to two decimals
 * of one while we carry the filing's full precision. Without a floor, relative
 * tolerance alone turns every near-zero value into a coin flip: 3PLAND FY2021
 * netIncome, ours −0.136 against theirs −0.12, is 13% relative on a ₹16,000
 * absolute gap.
 *
 * ₹0.5 crore is chosen to sit well above that representation noise and far
 * below any figure a reader would act on. It is deliberately NOT a widened
 * relative tolerance: the 1% band still governs everything of material size, so
 * this cannot quietly absorb a real 1% error on a large company.
 */
const ABSOLUTE_EPSILON_CR = 0.5;
/**
 * Share of a field's comparable pairs the exclusions may remove before a
 * READY verdict stops being meaningful — MONEY-1237 item 7.
 */
const EXCLUSION_DRAIN_FLOOR = 0.5;

/*
 * `periodLabel` is imported from `@usemoney/core/market-data`, NOT redefined
 * here. It used to be a byte-identical private twin, and that duplication was
 * the hazard: this script produces the EVIDENCE that arms the switchover, while
 * `xbrl-projection-writer.ts` performs the WRITE, and both address a
 * `StockFinancials` row by the same derived label. Two copies means a fix to
 * one silently changes which rows the other looks at — the evidence would then
 * describe a different set of rows than the write touches, and nothing would
 * error. One definition, one join. (MONEY-1204)
 */

/**
 * Why a comparison exists but must not be GRADED — MONEY-1235.
 *
 * `QUARANTINED` is this script's name for the writer's `refusedScaleSuspect`,
 * which is a FILING-level refusal and therefore has no `FinancialsSkipReason` of
 * its own. Everything else is `planFinancialsWrite`'s own vocabulary, carried
 * through unmapped: a skip reason added there appears here for free, where a
 * translation table would be one more thing to forget to update.
 *
 * `SYMBOL_EXCLUDED` is the ODD ONE OUT and the difference is not cosmetic —
 * MONEY-1255. Every other value here means THE WRITER WILL NOT PERFORM THIS
 * WRITE, which is why removing those rows leaves the gate measuring the writer.
 * `SYMBOL_EXCLUDED` means the writer WILL write the row and we have chosen not
 * to grade it. That is a decision to arm over a known-bad population, and the
 * report says so in those words rather than filing it beside the others. See
 * {@link EXCLUDED_SYMBOLS}.
 */
type Exclusion = "QUARANTINED" | "SYMBOL_EXCLUDED" | FinancialsSkipReason;

/**
 * Fields whose disagreement with the vendor is UNDERSTOOD and must not block —
 * MONEY-1255 (D2).
 *
 * ## The instrument, and when it is the right one
 *
 * Sibling of `DECLARED_DIVERGENCES` in `scripts/data/xbrl-ratios-validate.ts`,
 * and held to the same bar: the difference must be DEFINITIONAL, MEASURED, and
 * — the part that matters most — **impossible to close from the documents we
 * hold**. A gap we could close by parsing more of the filing is a COVERAGE gap,
 * and the rule for those is to fix them. (`totalCash` is the worked
 * counter-example over there: same one-directional signature, deliberately NOT
 * declared, because both missing terms are on the same balance sheet and we
 * simply do not map them.)
 *
 * A declaration is also NOT the instrument when the right answer is to stop
 * writing the column. Where our figure and the vendor's are different
 * quantities AND we can keep both, not-claiming beats declaring — that is what
 * MONEY-1255 did to `revenue`, `operatingIncome` and `ebitda`, whose evidence
 * now lives in {@link UNOWNED_VENDOR_COLUMNS}. A declaration keeps the write
 * and annotates it; it is for a column we DO own and mean to keep writing.
 *
 * ## What declaring costs, stated plainly
 *
 * `stock_financials` has no `source` in its unique key, so arming replaces the
 * vendor's `totalDebt` with ours on every period we write. Declaring does not
 * make that harmless — it records that we looked, understood the difference,
 * and chose it. The ONLY thing separating this from a suppression is that a
 * declared field still prints its FULL census (comparable / matched /
 * disagreed / scale / sign / incomparable) and its evidence verbatim, and that
 * `judgeFieldGateOutcome` gives it a verdict of its own instead of laundering
 * it into READY. If either of those is ever removed, this map becomes a way to
 * turn a red gate green and should be deleted with it.
 */
const DECLARED_FIELD_DIVERGENCES: Partial<Record<Field, DeclaredDivergence>> = {
  /**
   * ## The two quantities
   *
   * OURS is what the filing's own funding lines add up to, and the sum has TWO
   * shapes because lenders file two ways (`projectFinancials`, xbrl-projection.ts):
   *
   *   ordinary filer  `borrowingsCurrent + borrowingsNonCurrent`
   *   Ind-AS LENDER   `borrowings + debtSecurities + deposits +
   *                    subordinatedLiabilities`
   *   RBI Form-A bank NOT OWNED AT ALL — `writableFields` removes it. Deposits
   *                   are a bank's franchise, not its gearing, and the vendor
   *                   publishes no `totalDebt` for a bank on 35 of 35
   *                   comparable rows either.
   *
   * THEIRS is a different aggregation and the measured difference on the
   * ordinary-filer population is Ind-AS 116 LEASE LIABILITIES, which the
   * integrated-filing taxonomy does not publish as a balance element at all.
   *
   * ## Why the four-line lender sum is not the thing being declared
   *
   * Worth separating, because it is the part that is NOT a divergence. Against
   * the incumbent on 135 Ind-AS-shape company-years, `Borrowings` alone agrees
   * within 1% on 21 and the four-way sum on 100; above Rs 10,000 Cr of debt, 0
   * of 43 versus 37 of 43. Third-sourced to 0.00% on BAJFINANCE FY2024/25/26,
   * SHRIRAMFIN, CHOLAFIN and MUTHOOTFIN. The four-line sum AGREES with the
   * vendor. What is declared is the ordinary-filer gap underneath it.
   *
   * ## `null` when unsourceable, never 0
   *
   * The lender sum is `sumPresent`, which returns `undefined` when every part
   * is absent rather than folding an empty list to 0. That distinction is the
   * whole reason this can be declared instead of blocking: a 0 would be a
   * factual claim of zero debt that a screener would rank on, and it would be
   * indistinguishable from a company that genuinely has none.
   */
  totalDebt: {
    reason:
      `our \`totalDebt\` is what the FILING's own funding lines sum to — ` +
      `\`borrowingsCurrent + borrowingsNonCurrent\` for an ordinary filer, and ` +
      `for an Ind-AS LENDER the four-line \`borrowings + debtSecurities + ` +
      `deposits + subordinatedLiabilities\` (an RBI Form-A bank does not own ` +
      `the column at all). The vendor uses a different aggregation whose extra ` +
      `term is Ind-AS 116 LEASE LIABILITIES. Neither side is wrong; they are ` +
      `not the same quantity, and every part is read off the filing or left ` +
      `null — sumPresent returns undefined rather than 0 when nothing is ` +
      `disclosed, so an unsourceable debt is never published as "no debt"`,
    evidence:
      `1,307 of 1,398 disagreeing pairs (93.5%) run theirs > ours — a ` +
      `near-one-way direction is the signature of a missing additive term, not ` +
      `of scatter. 267 of them have our borrowings EXACTLY zero while the ` +
      `incumbent still assigns debt: TCS 9,392 Cr, PETRONET 2,657, BATAINDIA ` +
      `1,446, MPHASIS 1,116, LTTS 578 — the famously debt-free, lease-heavy ` +
      `names. screener.in reproduces the incumbent to <0.5% on 12 of 20 pairs ` +
      `against 1 of 20 for ours. BATAINDIA's borrowings step 0 -> 1,249 Cr at ` +
      `Mar-2020, the Ind-AS 116 adoption year, with Fixed Assets 317 -> 1,369 ` +
      `in the same year (the right-of-use asset, the other half of the entry) ` +
      `and no borrowing event; TCS shows the same step, 62 -> 8,174, 51x its ` +
      `own median year-on-year move. CANNOT BE CLOSED FROM THE FILINGS: across ` +
      `all 11,296 annual filings we hold and 8 raw documents fetched from NSE, ` +
      `the integrated-filing taxonomy's ONLY lease element is ` +
      `PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities, a CASH-FLOW ` +
      `item. There is no lease-liability BALANCE element to parse. Separately, ` +
      `the four-line LENDER sum AGREES with the vendor — 100 of 135 Ind-AS ` +
      `lender company-years within 1% against 21 for borrowings alone, 37 of ` +
      `43 above Rs 10,000 Cr against 0, third-sourced to 0.00% on BAJFINANCE, ` +
      `SHRIRAMFIN, CHOLAFIN and MUTHOOTFIN`,
  },
};

/**
 * Symbols removed from the comparison population entirely — MONEY-1255 (D3).
 *
 * ## READ THIS BEFORE ADDING ONE
 *
 * This is the ONE exclusion in this file that does not measure the writer. Every
 * other one — `QUARANTINED`, `STANDALONE_NO_DISPLACE`, `AUTHORITY` — removes a
 * comparison because THE WRITE WILL NOT HAPPEN, so the incumbent survives and
 * there is nothing to grade. These rows WILL be written. Excluding them does
 * not make the gate more accurate about what arming does; it makes the gate
 * agree to arm anyway, over a population we have already found to be wrong.
 *
 * That is a founder decision and it is recorded as one. The mechanics that keep
 * it from becoming a way to delete red lines:
 *
 *  1. Every symbol here gets a PRINTED row saying exactly what it removed —
 *     including the ones that removed NOTHING, which is the row a reader needs
 *     most (`tallySymbolExclusions` seeds from this list, not from the rows).
 *  2. The removals flow through the ordinary `excluded` machinery, so the
 *     existing "READY RESTS ON THE EXCLUSION: N scale and M sign mismatch(es)
 *     left this field's ladder that way" line fires on them automatically.
 *  3. `nullsIncumbent` is computed against the WRITER's skip only, never
 *     against this list — the writer still writes these rows, so the incumbent
 *     values they destroy still count.
 *
 * ## The two, and what is actually known about each
 *
 * Only MODIRUBBER had any prior written finding in this repo (the SIGN_MISMATCH
 * note in the translation ladder below). The reasons below are read off the
 * PROD RUN of 2026-08-26 — the full-population run, `VERDICT: NOT ready over
 * the 50640 GRADED comparison(s)` — and nothing here is inferred beyond it.
 *
 * ## It was FOUR, and the two that left are why mechanic (1) exists
 *
 * CENTUM and DVL were listed here on the same founder instruction and have been
 * moved to `EXCLUDED_SYMBOLS` in `scripts/data/xbrl-ratios-validate.ts`. Their
 * two `SIGN_MISMATCH` verdicts are on `roe`, in the SIBLING gate; in THIS gate
 * they contribute no scale row, no sign row, and appear nowhere in the output,
 * so both would have printed `removed 0 comparison(s)` followed by the
 * REMOVED NOTHING warning — an exclusion that buys nothing here while reading,
 * to anyone scanning the list, as though four symbols were holding the
 * financials ladder back.
 *
 * That is exactly the reading the zero-row rule was built to force, and it is
 * worth stating that it worked: the mechanism found two entries on its own list
 * that belonged somewhere else. An exclusion has to be declared in the gate
 * whose verdict it changes, or it is a footnote in the wrong report.
 */
const EXCLUDED_SYMBOLS: Readonly<Record<string, string>> = {
  MODIRUBBER:
    `TWO independent unconditional blockers from one symbol, and the only ` +
    `symbol on the ladder with both. (1) FY2021 revenue SCALE_MISMATCH, ` +
    `ours=2.7717 theirs=27.48, factor 10 — one of the 7 surviving the ` +
    `quarantine, and the scale detector explicitly CLEARED it ("OK, 6 sibling ` +
    `period(s)"), so it is not reachable by tuning the detector. (2) FY2025 ` +
    `operatingIncome SIGN_MISMATCH, ours=-24.0624 theirs=+23.92 — |theirs| is ` +
    `0.6% from |ours|, i.e. the vendor carries the MAGNITUDE of an operating ` +
    `loss as a positive number, which matches no definitional candidate and is ` +
    `the shape this file already names as a genuine sign bug`,
  OPTIEMUS:
    `FY2021 operatingIncome SIGN_MISMATCH, ours=-102.57 theirs=+103.4 — ` +
    `|theirs| is 0.8% from |ours|, the same vendor-side loss-as-positive shape ` +
    `as MODIRUBBER FY2025. These two are the ONLY surviving sign mismatches in ` +
    `the whole 50,640-comparison run, and the ladder blocks unconditionally on ` +
    `any one of them`,
  // The other two of the founder's original four are NOT here — they block the
  // RATIOS gate on `roe` and are declared in
  // `scripts/data/xbrl-ratios-validate.ts`. See the docstring above.
};

/**
 * The exclusion list as a lookup, built once. Symbols are upper-cased on both
 * sides so a lower-case entry cannot silently exclude nothing.
 */
const EXCLUDED_SYMBOL_SET: ReadonlySet<string> = new Set(
  Object.keys(EXCLUDED_SYMBOLS).map((s) => s.toUpperCase()),
);

/**
 * What the ladder REPORTS, which is one bucket wider than what it JUDGES —
 * MONEY-1239.
 *
 * `ReconcileVerdict` is the writer-facing vocabulary and it is not changed here:
 * a translated pair still enters `judgeSwitchoverReadiness` as `MATCH`, exactly
 * as it did before, so no readiness threshold and no write decision moves. What
 * changes is that the report no longer says "MATCH" about a pair that only
 * agreed after the vendor's own definition was reconstructed.
 *
 * The distinction has to be VISIBLE because the two are different evidence. A
 * raw MATCH says the two sources agree about a number. A TRANSLATED pair says
 * they agree about the FACTS and disagree about which quantity the column
 * names — true, actionable, and not the same claim. Folding the second into the
 * first is how "97% match" gets read as "97% of our numbers equal theirs".
 */
type Classification = ReconcileVerdict | "TRANSLATED";

interface Comparison {
  symbol: string;
  period: string;
  /** `XbrlFiling.id` of the winner, so an excluded row can name its judgement. */
  filingId: string;
  /**
   * The WINNER's basis — MONEY-1250.
   *
   * Needed by the OURS-BLANK report to answer the question that opened the
   * ticket: of the periods where we have no value, how many are ones where the
   * only filing we hold is STANDALONE? That is the basis-mismatch population,
   * and it is the one a reader would otherwise assume the whole shortfall was.
   * Measured on prod 2026-08-24 it is 500 of 2,165 on every balance-sheet
   * field — a minority, and none of them a basis mismatch in the sense that
   * matters, because our side is empty rather than on the wrong basis.
   */
  basis: string;
  field: Field;
  ours: number | undefined;
  theirs: number | undefined;
  /** What the JUDGE is told. Unchanged by MONEY-1239. */
  verdict: ReconcileVerdict;
  /** What the REPORT says. `TRANSLATED` wherever `verdict` was upgraded. */
  classification: Classification;
  /** Which reconstruction carried it, so the count is auditable per quantity. */
  translatedBy?: string;
  /**
   * This pair scored SIGN_MISMATCH before a translation rescued it —
   * MONEY-1236.
   *
   * Needed by the STRICT counterfactual, which asks "what would the ladder say
   * if no translation were allowed". Demoting every translated pair to
   * DISAGREEMENT answers that question WRONG in the permissive direction:
   * `judgeSwitchoverReadiness` blocks UNCONDITIONALLY on any sign mismatch but
   * treats a disagreement as a mere contributor to a rate, so a sign-rescued
   * pair demoted to DISAGREEMENT can let the counterfactual print "would read
   * READY" where the honest strict answer is BLOCKED. That line is the
   * founder's threshold input for a ONE-WAY DOOR.
   */
  signResolvedByTranslation?: true;
  /**
   * The DECLARED translation could not even be ATTEMPTED — the filing discloses
   * no `otherIncome` — and nothing else resolved the pair either. NOT a failed
   * translation: "we could not determine" is its own value, never folded into
   * "we determined it does not agree".
   */
  translationUnavailable?: true;
  /**
   * The writer WOULD perform this write, our side has no value, and the vendor's
   * does. Arming replaces a populated cell with NULL — MONEY-1239.
   */
  nullsIncumbent?: true;
  relativeDiff?: number;
  scaleFactor?: number;
  /**
   * Set when the writer would NOT perform this write, so the incumbent survives
   * and the pair is not evidence about anything. Undefined means graded.
   */
  excluded?: Exclusion;
}

/**
 * The fields where the vendor's column is OUR column PLUS OTHER INCOME —
 * MONEY-1239.
 *
 * Measured on prod (7,167 comparisons, relative-difference percentiles), and
 * the three magnitudes are ONE phenomenon — the same absolute other-income
 * amount over three different denominators:
 *
 *   field              n     p50     p75     p90     p95     p99   within 1%
 *   revenue          2442   2.19%   6.93%  21.95%  51.00%  95.53%    29.7%
 *   netIncome        2443   0.01%   0.14%   3.20%  19.54%  99.43%    86.9%
 *   operatingIncome  2282  17.16%  41.54%  91.07% 117.46% 163.32%     3.0%
 *
 * Adjudicated against screener.in as a THIRD source: 3MINDIA reconciles 12/12
 * to the rupee against screener's CONSOLIDATED over FY2021-23 x {revenue,
 * netIncome, operatingIncome, ebitda}, while the vendor matches screener's
 * STANDALONE. Our projection is right; the gate was blocking on a definition.
 *
 *   revenue          theirs is TOTAL INCOME (revenue from operations + other
 *                    income); ours is revenue from operations.
 *   operatingIncome  theirs is EBIT INCLUDING other income; ours EXCLUDES it,
 *                    deliberately — see the `operatingIncome` derivation in
 *                    `xbrl-projection.ts`, which says so in as many words.
 *
 * `netIncome` is DELIBERATELY ABSENT and must stay absent. Both sides mean
 * profit attributable to owners, so there is NO other-income gap to close —
 * p50 0.01%, 86.9% within 1% — and a translation there would have nothing to
 * explain and everything to hide. It would only ever fire on a pair that is
 * genuinely wrong, which is precisely the pair the gate exists to surface.
 *
 * ## UNREACHABLE AS OF MONEY-1255, and left standing deliberately
 *
 * The two entries below now name OUR columns, not the vendor's. MONEY-1255
 * took the conclusion this translation was evidence FOR and made it structural:
 * `revenue`, `operatingIncome` and `ebitda` are no longer written at all
 * ({@link UNOWNED_VENDOR_COLUMNS}), and our figures moved to
 * `revenueFromOperations` / `operatingIncomeExOtherIncome` /
 * `ebitdaBeforeExceptionalItems`, which the vendor has never populated on any
 * of ~32,359 rows.
 *
 * So every pair on these fields scores INCOMPARABLE (`theirs` absent), the
 * translation branch — which only runs on DISAGREEMENT or SIGN_MISMATCH — is
 * never entered, and the field reads UNVERIF rather than READY or BLOCKED.
 * That is the correct verdict: there is no incumbent to destroy, so there is no
 * door to hold shut.
 *
 * They are RENAMED rather than DELETED because the reachability is a property
 * of the DATA, not of the code: the day anything backfills the vendor's reading
 * into `revenueFromOperations`, these pairs become comparable and the
 * reconstruction is the only thing that would explain the gap. The report says
 * out loud which of the two states a run is in — see the UNOWNED-COLUMNS block
 * — so "translated 0" can never be mistaken for "nothing to translate".
 */
const OTHER_INCOME_TRANSLATED: ReadonlySet<Field> = new Set<Field>([
  "revenueFromOperations",
  "operatingIncomeExOtherIncome",
]);

/**
 * One candidate quantity, with the name of what it reconstructs.
 *
 * The label is not decoration. "ours + X == theirs for some X" is not evidence
 * of anything, so every candidate has to say WHICH published quantity it is and
 * be built from concepts read off THE SAME FILING — never a fitted constant.
 */
interface Translation {
  label: string;
  value: number;
}

/** Per-field translation tally, kept so the ladder can print the shape. */
interface FieldTranslations {
  translated: number;
  /** Declared translation not attemptable — no `otherIncome` in the filing. */
  unavailable: number;
}

function emptyFieldTranslations(): FieldTranslations {
  return { translated: 0, unavailable: 0 };
}

/**
 * What one field's exclusions removed, kept so the report can say it.
 *
 * `scale` / `sign` / `disagree` are the verdicts the removal HID. They exist for
 * one line in the report — "READY rests on the exclusion" — which is the only
 * thing standing between this change and the bug it is modelled on: a field
 * whose blockers were excluded prints `scale 0` and reads exactly like a field
 * that never had any.
 */
interface FieldExclusions {
  total: number;
  /** Pairs where BOTH sides had a value. The only ones a rate could have used. */
  comparable: number;
  byReason: Map<Exclusion, number>;
  scale: number;
  sign: number;
  disagree: number;
}

function emptyFieldExclusions(): FieldExclusions {
  return {
    total: 0,
    comparable: 0,
    byReason: new Map<Exclusion, number>(),
    scale: 0,
    sign: 0,
    disagree: 0,
  };
}

/**
 * Above this share of a field's would-be comparable pairs, an exclusion is large
 * enough that the readiness verdict is a statement about a DIFFERENT population
 * than the one a reader assumes, and the line says so.
 *
 * 10% is not a threshold anything passes or fails on — nothing here blocks on
 * it. It is the point at which "N excluded" stops being a footnote, chosen well
 * below the 29.5% that `STANDALONE_NO_DISPLACE` is already known to remove so
 * that the known case is guaranteed to trip it rather than sitting just under.
 */
const EXCLUDED_SHARE_NOTE = 0.1;

/**
 * The filing columns this gate reads, hoisted out of the query — MONEY-1287.
 *
 * Lifted verbatim so the paged reader below can hand the SAME projection to
 * every page. A second copy of this list would be the `FIELDS`/`select` drift
 * MONEY-1250 already paid for once: a column missing from a SELECT comes back
 * `undefined`, which the ladder reads as "the vendor has no value here" and
 * reports as INCOMPARABLE — a zero that means "we never asked" is
 * indistinguishable in the report from a zero that means "nothing to compare".
 */
const FILING_SELECT = {
  // MONEY-1235 — `id` is the scale detector's join key: `ScaleObservation`
  // identifies siblings by `filingId` so a candidate can be excluded from
  // its own context. `cumulative` completes the provenance object
  // `planFinancialsWrite` requires (it is the one non-optional field of
  // `ProjectionRawData["xbrl"]["filing"]` this query did not already carry).
  id: true,
  // MONEY-1237 — `judgeProjectionEligibility` needs the span. Without it
  // this gate could not mirror the writer's refusals, so a 546-day
  // transition-year filing shared a group with the 365-day one and could
  // WIN it on coverage — 18 months of revenue graded against the vendor's
  // 12 and reported as a data defect.
  periodStart: true,
  cumulative: true,
  symbol: true,
  exchange: true,
  periodEnd: true,
  periodType: true,
  basis: true,
  facts: true,
  // MONEY-1236 — the writer puts this on the provenance it hands
  // `planFinancialsWrite`; the gate must construct the SAME object or it is
  // not measuring the writer. `taxonomyVersion` is recorded rather than
  // planned on, so unlike `family` it does not change a verdict — but a
  // parity guard that tolerates "this one does not matter" is how the one
  // that DID matter got through.
  taxonomyVersion: true,
  coverage: true,
  // `filedAt` and `sourceUrl` are read ONLY by `selectFilingForPeriod`, and
  // omitting them is not a small loss: its tie-break chain is
  // basis -> coverage -> filedAt -> sourceUrl, and it is documented as
  // needing to be a TOTAL order so the winner is a function of the candidate
  // SET and not of the order the query returned. Fetch three of four and a
  // tie resolves by row order, which is the instability that function exists
  // to remove.
  filedAt: true,
  sourceUrl: true,
} as const;

/** One `XbrlFiling` row as this gate reads it. */
type FilingRow = Prisma.XbrlFilingGetPayload<{ select: typeof FILING_SELECT }>;

/**
 * Symbols per page of the filings read — MONEY-1287.
 *
 * ## THE DEFECT this replaces
 *
 * The read was ONE `findMany` over the whole of `xbrl_filings` with no `take`
 * unless `--limit` was passed, selecting `facts: true` — the parsed filing, the
 * largest column in the table. Measured on prod 2026-08-30:
 *
 *     collStats xbrl_filings   625,101,389 bytes   108,020 docs   avgObjSize 5,786
 *
 * Prisma's Rust engine serialises a result set to ONE JSON string and hands it
 * across the napi boundary, and a V8 string has a hard length ceiling. The run
 * did not degrade, it ABORTED:
 *
 *     Invalid `prisma.xbrlFiling.findMany()` invocation
 *     Failed to convert rust `String` into napi `string`   → EXIT=1
 *
 * Per the runbook, a non-zero exit from this gate means "we compared nothing",
 * which must never be read as "everything matched". So the documented arming
 * PRECONDITION for the whole XBRL switchover was un-runnable: only
 * `--limit=20000` completed, and that is 471 of ~2,467 annual symbols. It gets
 * worse on its own as the backfill grows — the one failure mode a one-way-door
 * gate must not have is being quietly impossible to run.
 *
 * ## Why SYMBOL is the paging key and not `id` or `periodEnd`
 *
 * Because every grouping downstream is symbol-scoped, so a symbol boundary is
 * the only cut that changes NOTHING:
 *
 *   - `selectFilingForPeriod` groups on (symbol, exchange, periodType, period);
 *   - `judgeFilingScale`'s sibling context is keyed (symbol, periodType);
 *   - the incumbent join chunks `wantedSymbols`.
 *
 * An `id`- or `periodEnd`-keyed page can cut BETWEEN a STANDALONE filing and
 * the CONSOLIDATED sibling that supersedes it — handing the period to the loser
 * — which is MONEY-1232's defect reintroduced by the paging rather than by the
 * ordering. Paging by symbol cannot: both siblings are always in the same page.
 *
 * 200 matches the incumbent chunk (`CHUNK` below), so a page costs one filings
 * query and one `stock_financials` query.
 */
export const SYMBOL_PAGE_SIZE = 200;

/**
 * What the pager needs of `prisma.xbrlFiling` — nothing else.
 *
 * Narrow on purpose: the test injects a counted double through this interface
 * (`as unknown as`, the same idiom `ScreenerDeps["prisma"]` uses), and a wider
 * type would drag the whole generated delegate into the fixture.
 */
export interface SymbolPagedFilings<Row> {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: unknown;
    select: Record<string, boolean>;
    distinct?: readonly string[];
    take?: number;
  }): Promise<Row[]>;
}

/** What one paged read spent and returned. */
export interface SymbolPageStats {
  /** `findMany` calls spent on PAGES. The symbol census is one call on top. */
  pages: number;
  /** Distinct symbols the census found. */
  symbols: number;
  /** Filings actually handed to `onPage`, after any `--limit` cut. */
  filings: number;
}

/**
 * Read `XbrlFiling` a page of SYMBOLS at a time, handing each page to `onPage`.
 *
 * The rows a caller sees, in the order it sees them, are BYTE-FOR-BYTE the ones
 * the single unbounded query returned — that identity is the whole point, and
 * `reconcile-symbol-paging.test.ts` pins it against a single-shot oracle rather
 * than against golden values:
 *
 *   - the census is `distinct` + `orderBy: symbol asc`, and is re-sorted here
 *     rather than trusted from the connector, so pages are ascending, disjoint
 *     and exhaustive;
 *   - each page keeps the original `[{symbol: asc}, {periodEnd: desc}]`, so
 *     concatenating the pages reproduces the global order exactly;
 *   - `--limit` is spent ACROSS pages (`take: limit - filingsSoFar`), so it
 *     still cuts the same symbol-major prefix a single `take: LIMIT` did.
 *
 * `where` is spread BEFORE `symbol: { in: batch }`, so a `--symbols=` run has
 * its filter applied by the census and then narrowed per page. The batch is
 * always a subset of the caller's own filter, never a widening of it.
 *
 * The census costs one extra round trip and streams `{symbol}` only — Prisma's
 * Mongo connector de-duplicates `distinct` in the engine rather than pushing a
 * `$group` down (`stock-document-parse.ts` measured that and says so), so it
 * does read every matching row, but at a ~40-byte projection instead of a
 * 5,786-byte one. That is ~4 MB against the 625 MB that could not cross the
 * napi boundary at all.
 *
 * MEASURED against QA 2026-08-30, read-only: this exact call —
 * `distinct` + `select: {symbol}` + `orderBy: {symbol: asc}` — is accepted by
 * the connector and returned 1,223 symbols in 670 ms, genuinely ascending. The
 * `.sort()` below is therefore belt-and-braces rather than a workaround, and
 * the page query returned its STANDALONE/CONSOLIDATED siblings adjacent, which
 * is the MONEY-1232 property the whole paging key rests on. Worth measuring
 * rather than assuming: an unsupported argument here would throw, and this gate
 * failing to run IS the defect being fixed.
 */
export async function readFilingsBySymbolPage<Row extends { symbol: string }>(
  delegate: SymbolPagedFilings<Row>,
  opts: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    /** `--limit`, a cap on FILINGS across all pages. 0 / absent = no cap. */
    limit?: number;
    pageSize?: number;
  },
  onPage: (rows: Row[]) => Promise<void> | void,
): Promise<SymbolPageStats> {
  const pageSize = Math.max(1, opts.pageSize ?? SYMBOL_PAGE_SIZE);
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 0;

  const census = await delegate.findMany({
    where: opts.where,
    select: { symbol: true },
    distinct: ["symbol"],
    orderBy: { symbol: "asc" },
  });
  // Sorted HERE rather than relied on from the query. The page boundaries are
  // only disjoint and exhaustive if the list is genuinely ordered, and a
  // connector that returned `distinct` in insertion order would produce
  // overlapping pages that silently double-count symbols — a defect that shows
  // up as inflated match rates, i.e. in the direction that arms the switchover.
  const symbols = [...new Set(census.map((r) => r.symbol))].sort();

  const stats: SymbolPageStats = {
    pages: 0,
    symbols: symbols.length,
    filings: 0,
  };
  for (let i = 0; i < symbols.length; i += pageSize) {
    if (limit > 0 && stats.filings >= limit) break;
    const rows = await delegate.findMany({
      where: { ...opts.where, symbol: { in: symbols.slice(i, i + pageSize) } },
      // SYMBOL-MAJOR, and that is not cosmetic — MONEY-1232. With `--limit`, a
      // page ordered purely by `periodEnd` can cut BETWEEN a STANDALONE filing
      // and the CONSOLIDATED sibling that supersedes it, handing the period to
      // the loser. Ordering by symbol first means a truncated page can only cut
      // inside ONE symbol. `xbrl-projection-writer.ts` already orders this way
      // for the same reason; the gate has to match the writer or it is not
      // measuring it.
      orderBy: [{ symbol: "asc" }, { periodEnd: "desc" }],
      select: opts.select,
      ...(limit > 0 ? { take: limit - stats.filings } : {}),
    });
    stats.pages += 1;
    const page =
      limit > 0 && stats.filings + rows.length > limit
        ? rows.slice(0, limit - stats.filings)
        : rows;
    stats.filings += page.length;
    if (page.length > 0) await onPage(page);
  }
  return stats;
}

async function main(): Promise<void> {
  const where = SYMBOLS.length > 0 ? { symbol: { in: SYMBOLS } } : {};

  // ── Everything below survives a page — MONEY-1287 ───────────────────
  //
  // These were declared inside the single linear pass over the whole table.
  // They are hoisted VERBATIM, above `processPage`, because the pass is now one
  // page of symbols at a time: a tally declared inside the loop would reset
  // every 200 symbols and the report would describe the last page. Nothing here
  // changed except where it is declared — no threshold, no verdict, no
  // comparison.
  //
  // What is NOT hoisted is anything keyed by FILING (`groups`, `targetOf`,
  // `observations`, `projectedWinners`, `bySymbol*`, `incumbents`). Those are
  // symbol-scoped by construction, so they stay page-local and the parsed
  // `facts` blobs they hold are released when the page ends. That is the whole
  // memory win: `comparisons` keeps ~10 small rows per period, never the 5,786
  // bytes of filing that produced them.
  const refusalCounts = new Map<string, number>();
  /** Filings read across every page — the old `filings.length`. */
  let totalFilings = 0;
  /** Winner periods across every page — the old `winners.length`. */
  let totalWinners = 0;
  /** Siblings a winner displaced, across every page. */
  let totalSuperseded = 0;
  /** Scale observations built, across every page. */
  let totalObservations = 0;
  /**
   * Symbols carrying at least one observation. Summed across pages rather than
   * held in a Set: pages partition the population BY SYMBOL, so no symbol can
   * be counted twice and the sum is exact.
   */
  let totalObservedSymbols = 0;
  /** Incumbent rows loaded, symbols asked for, and queries spent. */
  let incumbentRowsLoaded = 0;
  let incumbentSymbols = 0;
  let incumbentQueries = 0;
  const comparisons: Comparison[] = [];
  let noIncumbent = 0;
  /** Pairs that only agreed once the vendor's definition was matched. */
  let translatedMatches = 0;
  /**
   * Which reconstruction carried each translated pair — MONEY-1239. A single
   * total cannot distinguish "the declared other-income gap explains this" from
   * "four fallback hypotheses between them explain this", and those are
   * different claims about how well the two sources are understood.
   */
  const translationLabels = new Map<string, number>();
  /**
   * SIGN_MISMATCH verdicts that turned out to be the vendor's own declared
   * definition matching tightly — definitional, not a sign convention bug.
   * MONEY-1237; BOMDYEING FY2021 is the proving case (PBT+FC within 0.04%).
   */
  let signTranslations = 0;
  /**
   * Every winner's scale verdict, kept so a MISS can name its own cause —
   * MONEY-1235. "The detector caught 9 of 15" is a number; "the other 6 had
   * only 2 sibling periods" is a decision about whether to arm.
   */
  const scaleJudgements = new Map<string, ScaleJudgement>();
  // Keyed by number|string — MONEY-1250. `SCALE_SUSPECT` buckets by its power
  // of ten; `SCALE_BASIS_CONFLICT` has no factor to bucket by and reports under
  // a named, undecidable bucket instead.
  const quarantineFactors = new Map<number | string, number>();
  let quarantinedPeriods = 0;
  /** Verdicts that would CHANGE if the detector saw the whole symbol history
   * instead of the writer's ANNUAL-scoped nightly page — MONEY-1237. */
  let scopeDivergence = 0;
  // A CALLER BUG, counted so it can never be silent again — MONEY-1236.
  //
  // `CANDIDATE_NOT_IN_CONTEXT` means the detector was handed a context that does
  // not contain the filing it was asked to judge, so nothing could place it in
  // its own series. That is never benign, and it read as INSUFFICIENT_CONTEXT —
  // the same verdict a first-ever filer gets — while the quarantine was off for
  // every QUARTERLY winner. It is fixed, and it exits non-zero if it returns.
  let candidateNotInContext = 0;
  const insufficientReasons = new Map<string, number>();
  /** How many scoped siblings each winner's detector call actually had. */
  const siblingDistribution = new Map<string, number>();
  let quarantinedWithVendor = 0;
  let quarantinedNoVendor = 0;
  /** Statement-level skips, straight from `planFinancialsWrite`, by reason. */
  const plannedSkips = new Map<FinancialsSkipReason, number>();
  /**
   * Set when the STANDALONE_NO_DISPLACE mirror produced ZERO skips — MONEY-1237.
   * 3,208 of 10,879 winner periods are standalone-only, so the expected count is
   * in the thousands; a zero means this gate's mirror of the writer's decision
   * has DIVERGED and the ladder is grading a different population from the one
   * that will ship. Consumed beside the contamination gate, because `allReady`
   * is declared later in this function.
   */
  let standaloneMirrorDiverged = false;
  /**
   * Incumbent rows ALREADY stamped `NSE_XBRL`. Expected to be zero — the
   * projection has never been armed — and reported rather than assumed,
   * because a non-zero here means this gate is partly comparing XBRL against
   * itself, which is a tautological MATCH that inflates every rate, and it also
   * means `BASIS_DOWNGRADE` would need the `rawData` this query deliberately
   * does not fetch. Both facts are invisible unless counted.
   */
  let xbrlIncumbents = 0;
  /**
   * `planFinancialsWrite` stamps a `displacedAt`, which nothing here reads. One
   * clock for the WHOLE RUN — deliberately outside the page loop, so the plans
   * stay a function of the data and not of which page happened to be running.
   */
  const NOW = new Date();

  /**
   * One page of symbols, start to finish — MONEY-1287.
   *
   * The body is the previous whole-table pass, unchanged. It is a function now
   * only so the parsed `facts` it holds fall out of scope at the end of each
   * page. `filings` keeps its name for that reason too: every `typeof filings`
   * and every read below means the same thing it always did, scoped to a page.
   */
  async function processPage(filings: FilingRow[]): Promise<void> {
    // ── One period, one row — MONEY-1232 ────────────────────────────────
    //
    // THE DEFECT this replaces: this script compared EVERY filing against the
    // incumbent. `XbrlFiling`'s key is
    // (symbol, exchange, periodEnd, periodType, basis, cumulative), so a company
    // that files both CONSOLIDATED and STANDALONE for a period has TWO rows here —
    // but `StockFinancials` has no `basis` in its key, so only ONE of them is ever
    // written. `xbrl-projection-writer.ts:507` groups and calls
    // `selectFilingForPeriod`; this script selected `basis` and then never read it.
    //
    // Measured on prod 2026-08-20, ANNUAL only: 10,982 filings collapse to 6,549
    // distinct (symbol, exchange, periodType, period) rows. The other 4,433 —
    // 40.4% — were being compared against an incumbent they will never replace.
    // The visible symptom was the same symbol/period appearing twice in the
    // examples with different `ours` values:
    //   AMBUJACEM FY 2022 revenue: ours=13964.95 theirs=31448.03   (standalone)
    //   AMBUJACEM FY 2022 revenue: ours=28965.46 theirs=31448.03   (consolidated)
    //
    // Why it had to be fixed before arming: this gate decides a ONE-WAY DOOR. A
    // population 40% larger than reality can report BLOCKED on disagreements from
    // rows that will never exist, or dilute real ones — untrustworthy in both
    // directions. The same `selectFilingForPeriod` the writer uses is imported
    // rather than reimplemented, so the two cannot drift.
    // ── The writer's REFUSALS, mirrored — MONEY-1237 ────────────────────
    //
    // The writer refuses a filing BEFORE grouping (`judgeProjectionEligibility`:
    // HALF_YEARLY has no bucket, a cumulative non-annual is not a quarter, a
    // span that contradicts its type, an unusable period). This gate used to
    // group everything, with two consequences: a 546-day transition-year filing
    // could WIN a period the writer would never let it enter — 18 months of
    // revenue graded against the vendor's 12 — and the "coverage gain" line
    // counted the 357 HALF_YEARLY rows and every span-refused annual as periods
    // XBRL covers. Neither is ground the writer will take. Refusals are counted
    // per reason; the group key is the VERDICT's target, exactly the tuple the
    // writer groups on. `refusalCounts` is hoisted above `processPage` so the
    // reasons accumulate across pages rather than resetting every 200 symbols.
    const targetOf = new Map<
      string,
      { periodType: "ANNUAL" | "QUARTERLY"; period: string }
    >();
    const groups = new Map<string, typeof filings>();
    for (const f of filings) {
      const verdict = judgeProjectionEligibility({
        periodStart: f.periodStart,
        periodEnd: f.periodEnd,
        periodType: f.periodType,
        cumulative: f.cumulative,
      });
      if (!verdict.eligible) {
        refusalCounts.set(
          verdict.refusal,
          (refusalCounts.get(verdict.refusal) ?? 0) + 1,
        );
        continue;
      }
      targetOf.set(f.id, verdict.target);
      const key = `${f.symbol}\u0000${f.exchange}\u0000${verdict.target.periodType}\u0000${verdict.target.period}`;
      const g = groups.get(key);
      if (g) g.push(f);
      else groups.set(key, [f]);
    }
    const winners = [...groups.values()]
      .map((rows) => selectFilingForPeriod(rows))
      .filter((f): f is (typeof filings)[number] => f !== null);
    // The census lines these three feed are printed ONCE, after every page — a
    // per-page "reconciling N of M" would read as progress and be mistaken for
    // the population the verdict describes.
    totalFilings += filings.length;
    totalWinners += winners.length;
    totalSuperseded += filings.length - winners.length;

    // ── The scale detector's context, built ONCE for the whole page ─────
    //
    // MONEY-1235. `judgeFilingScale` compares one filing's magnitudes against the
    // SAME COMPANY's other filings, and this loop is where those siblings come
    // from. NO query is added and none may be: one lookup per period is the N+1
    // that made this script un-runnable (MONEY-1234 measured it at 6h20m elapsed,
    // 0.0% CPU, killed unfinished), and a per-row scale context would reintroduce
    // it in the same shape. Everything needed is already in `filings`.
    //
    // Built from `filings`, NOT from `winners`, mirroring the writer, which calls
    // `observeScale` over the whole page BEFORE it groups. A STANDALONE sibling
    // that lost its period to the CONSOLIDATED one is still evidence about the
    // units this company reports in, and dropping the losers would push symbols
    // below `MIN_SIBLING_PERIODS` — turning a real judgement into
    // INSUFFICIENT_CONTEXT for the very companies that file both bases.
    //
    // The crore statements are cached for WINNERS ONLY. The comparison loop below
    // needs them and re-projecting would be pure waste, but holding two statements
    // for all 90,188 filings would keep objects for the 40% that lose their period
    // and are never compared.
    const winnerIds = new Set(winners.map((w) => w.id));
    const observations = new Map<string, ScaleObservation>();
    const bySymbol = new Map<string, ScaleObservation[]>();
    // SCOPED to the writer's nightly configuration — MONEY-1237 item 1.
    //
    // `judgeFilingScale` is the same function the writer calls, but "same
    // function" is not "same verdict" unless the CONTEXT matches too. The
    // nightly scheduler payload is `{"periodTypes":["ANNUAL"]}`
    // (scripts/ops/setup-scheduler.sh), so the writer's page — and therefore its
    // sibling context — contains ANNUAL filings only. This gate used to hand the
    // detector EVERY filing for the symbol, quarterlies included, so the two
    // could quarantine DIFFERENT periods: the gate could exclude a period from
    // its ladder that the writer would happily write (its ANNUAL-only context
    // answered INSUFFICIENT_CONTEXT), and drag an annual candidate's window
    // toward quarterly magnitudes in the other direction. The header's claim
    // that gate and writer "cannot drift apart" was false until this line.
    //
    // The UNSCOPED map is retained purely to REPORT the divergence — how many
    // verdicts change under the fuller context — so the drain (which runs whole
    // symbols, mixed period types) has a measured preview rather than a guess.
    // SCOPED BY THE CANDIDATE'S OWN PERIOD TYPE — MONEY-1236.
    //
    // This was a hardcoded `new Set(["ANNUAL"])`, matching the nightly scheduler
    // payload. The intent was right and the implementation switched the detector
    // OFF for every quarterly filing: a QUARTERLY candidate is not in an
    // ANNUAL-only array, so `resolveOrder` could not place it, and the verdict was
    // INSUFFICIENT_CONTEXT — always, silently, indistinguishably from a
    // first-ever filer. That is the quarantine disabled for exactly the
    // population the upcoming `createMissing` drain writes.
    //
    // Keying by (symbol, periodType) preserves the original intent and closes the
    // gap: an ANNUAL candidate still sees only ANNUAL siblings — the nightly
    // writer's page — and a QUARTERLY candidate sees QUARTERLY siblings, which is
    // what the drain's page will contain. The writer's own context is scoped the
    // same way by `contextTier`, so the two now agree by construction rather than
    // by a constant that has to be kept in sync with a scheduler payload.
    const scopeKey = (symbol: string, periodType: string) =>
      `${symbol}\u0000${periodType}`;
    const bySymbolScoped = new Map<string, ScaleObservation[]>();
    const projectedWinners = new Map<
      string,
      {
        statements: ProjectedFinancials[];
        unfilled: string[];
        /**
         * The taxonomy family — MONEY-1236.
         *
         * `planFinancialsWrite` narrows a LENDER's owned columns by this field
         * (a bank writes neither `operatingIncome` nor `ebitda`), and the writer
         * passes it. This gate did not, and `family` is OPTIONAL on the
         * provenance type, so the omission compiled cleanly and silently put the
         * gate on the FULL owned set while the writer used the narrowed one — in
         * a file whose own header claims the two "cannot drift apart".
         */
        family?: string;
        /** Whether the filing carries `bankCapital` — the Form-A discriminator. */
        bankCapitalPresent?: boolean;
      }
    >();
    for (const f of filings) {
      const facts = f.facts as unknown as XbrlFinancials | null;
      // Unreadable facts contribute NOTHING, not an empty observation. A phantom
      // sibling with no values would inflate the context tier's size — the count
      // `MIN_SIBLING_PERIODS` is checked against — without contributing a single
      // comparable magnitude, which is how a detector ends up judging a symbol it
      // has no evidence about.
      if (!facts || typeof facts !== "object" || !facts.values) continue;
      const projection = projectFinancials(facts);
      const statements = [projection.income, projection.balanceSheet]
        .filter((s): s is ProjectedFinancials => s !== null)
        .map(toCroreDenominated);
      if (winnerIds.has(f.id)) {
        projectedWinners.set(f.id, {
          statements,
          unfilled: projection.unfilled.map((u) => u.field),
          ...(typeof facts.family === "string" ? { family: facts.family } : {}),
          // ONE definition, imported — MONEY-1250 review. This was a bare
          // `!== undefined` while the projection used a finite-checked `num()`,
          // so a `bankCapital: NaN` put the gate and the writer on different
          // owned sets. That is the MONEY-1236 class.
          bankCapitalPresent: filerShapeOf(facts.values) === "RBI_FORM_A",
        });
      }
      // Read off the SAME crore statements the comparison and the write plan use.
      // A second, subtly different reduction is how a detector ends up clearing a
      // value the writer then mangles — so as of MONEY-1255 there is no second
      // reduction: `scaleValuesOf` is the SAME function `observeScale` calls in
      // the writer, and it owns the scale-label -> projected-column map. The
      // inline loop that used to live here indexed `statement["revenue"]`, which
      // stopped existing when the column was renamed, in both copies at once.
      const values = scaleValuesOf(statements);
      const obs: ScaleObservation = {
        filingId: f.id,
        basis: f.basis,
        periodType: f.periodType,
        // SUPPLY THE DATE — MONEY-1236.
        //
        // This was omitted, so `resolveOrder` fell to its array-position fallback
        // on every observation. The writer supplies `periodEnd` and therefore uses
        // the DATED axis, so the gate was ordering its series by a different rule
        // than the writer it exists to measure — while the header claimed the two
        // "cannot drift apart". The value was already selected and already used
        // two lines down for the label.
        periodEnd: f.periodEnd,
        label: periodLabel(f.periodEnd, f.periodType),
        // SUPPLY THE CROSS-BASIS INVARIANT'S INPUTS — MONEY-1250, and for the same
        // reason `periodEnd` above had to be supplied: an optional field the gate
        // leaves unset makes the judge see `undefined` on every observation, so the
        // detector is INERT here while remaining live in the writer. That is
        // gate-vs-writer drift, which this file's own header forbids.
        //
        // `paidUpEquityShareCapital` is identical across a company's two bases by
        // construction, so a >=9.5x disagreement is a scale problem in one of them.
        // Raw rupees, matching the writer: `toCroreDenominated` rebases owned
        // fields only, and this is not a StockFinancials column.
        ...(typeof facts.values?.paidUpEquityShareCapital === "number" &&
        Number.isFinite(facts.values.paidUpEquityShareCapital)
          ? { paidUpEquityShareCapital: facts.values.paidUpEquityShareCapital }
          : {}),
        ...(typeof facts.roundingLabel === "string"
          ? { roundingLabel: facts.roundingLabel }
          : {}),
        values,
      };
      observations.set(f.id, obs);
      const list = bySymbol.get(f.symbol);
      if (list) list.push(obs);
      else bySymbol.set(f.symbol, [obs]);
      const key = scopeKey(f.symbol, f.periodType);
      const scoped = bySymbolScoped.get(key);
      if (scoped) scoped.push(obs);
      else bySymbolScoped.set(key, [obs]);
    }
    // Summed, not logged per page. Pages partition BY SYMBOL, so `bySymbol.size`
    // counts a disjoint set every time and the totals are exact.
    totalObservations += observations.size;
    totalObservedSymbols += bySymbol.size;

    // ── Incumbents, loaded ONCE per page and keyed BY STATEMENT — MONEY-1234 ──
    //
    // TWO defects replaced here, in one query.
    //
    // (a) WRONG ROW. The lookup was `findFirst({symbol, exchange, period,
    //     periodType})` with NO `statementType`, selecting all six fields off
    //     whatever came back. But `StockFinancials` is keyed BY statement, and
    //     each row carries only its own columns. Measured on prod 2026-08-21,
    //     10,043 of 12,247 ANNUAL keys have THREE rows. RELIANCE FY 2024:
    //         BALANCE_SHEET  revenue=null      totalAssets=1755048
    //         CASH_FLOW      revenue=null      totalAssets=null
    //         INCOME         revenue=917121    totalAssets=null
    //     `findFirst` landed on BALANCE_SHEET in practice, so the income half of
    //     the ladder scored 2 comparable pairs out of 213 while the balance-sheet
    //     half scored 127. The income fields were not disagreeing — they were
    //     never being asked. The incumbent data is fully present: 12,209 of
    //     12,232 INCOME rows carry `revenue` (99.8%).
    //
    // (b) N+1. One `findFirst` per period is 54,160 sequential round trips to
    //     Atlas. Measured: killed at 6h20m elapsed and 0.0% CPU, still
    //     unfinished — the gate was effectively un-runnable, which is its own
    //     kind of failure for something that has to be re-run after every fix.
    //
    // The field -> statement mapping is IMPORTED (`INCOME_FIELDS`,
    // `BALANCE_SHEET_FIELDS`), not restated. They are the same constants
    // `ownedFields()` gives the writer, so the gate compares each column against
    // the row the writer would have written it to, by construction.
    const statementOf = (field: Field): "INCOME" | "BALANCE_SHEET" =>
      (INCOME_FIELDS as readonly string[]).includes(field)
        ? "INCOME"
        : "BALANCE_SHEET";

    const wantedSymbols = [...new Set(winners.map((w) => w.symbol))];
    // Typed as the writer's own `IncumbentFinancialsRow` — MONEY-1235 — because
    // these rows are now handed straight to `planFinancialsWrite`, so the gate
    // asks the planner what it would DO instead of re-deriving the answer. Note
    // what is deliberately NOT selected: `rawData`. It is a whole JSON blob per
    // row over tens of thousands of rows, and the only decision it feeds is
    // `BASIS_DOWNGRADE`, which compares OUR basis against the basis recorded on a
    // row WE wrote — impossible before the switchover is armed, since every
    // incumbent here is a vendor row. `storedProvenance(undefined)` returns null
    // and the guard stays inert, which is the correct answer for this population
    // rather than a silent one: the count of incumbents already stamped
    // `NSE_XBRL` is reported below precisely so that assumption is checked on
    // every run instead of being assumed on this one.
    const incumbents = new Map<string, IncumbentFinancialsRow>();
    const CHUNK = 200;
    for (let i = 0; i < wantedSymbols.length; i += CHUNK) {
      const rows = await prisma.stockFinancials.findMany({
        where: {
          symbol: { in: wantedSymbols.slice(i, i + CHUNK) },
          statementType: { in: ["INCOME", "BALANCE_SHEET"] },
        },
        select: {
          symbol: true,
          exchange: true,
          period: true,
          periodType: true,
          statementType: true,
          source: true,
          // DERIVED from FIELDS — MONEY-1250. This was the SAME hardcoded six as
          // the old FIELDS literal, one layer down, and it is the more dangerous
          // copy: a field missing from the SELECT comes back undefined, which the
          // comparison reads as "the vendor has no value here" and reports as
          // INCOMPARABLE. `totalDebt` scored `comparable 0 of 4516` while
          // `stock_financials` actually holds 9,861 TICKERTAPE values for it.
          //
          // A zero that means "we never asked" is indistinguishable in the report
          // from a zero that means "nothing to compare against" — and the second
          // is the reading that would have justified arming.
          ...Object.fromEntries(FIELDS.map((f) => [f, true])),
        },
      });
      for (const r of rows) {
        incumbents.set(
          `${r.symbol}\u0000${r.exchange}\u0000${r.periodType}\u0000${r.period}\u0000${r.statementType}`,
          r as IncumbentFinancialsRow,
        );
      }
    }
    incumbentRowsLoaded += incumbents.size;
    incumbentSymbols += wantedSymbols.length;
    incumbentQueries += Math.ceil(wantedSymbols.length / CHUNK);

    for (const f of winners) {
      // Projected ONCE, in the scale-context pass above, and reused here. Absent
      // means `facts` could not be read back as a parsed filing — the same rows
      // the writer counts as `unreadableFacts`.
      const cached = projectedWinners.get(f.id);
      if (!cached) continue;
      const { statements, unfilled } = cached;
      // `facts` is the whole parsed result, stored as Json. It round-trips
      // through Prisma as a plain object; the cast is the only place that
      // assumption lives.
      const financials = f.facts as unknown as XbrlFinancials;

      // RUPEES -> CRORES happened in `toCroreDenominated` (MONEY-1207).
      //
      // `projectFinancials` deliberately returns the document's own unit —
      // absolute rupees — so that `XbrlFiling.facts` never disagrees with the
      // filing it was parsed from. Every CONSUMER converts. This script is a
      // consumer and used to skip the step, so it compared ₹4.7e12 of XBRL
      // against ₹4,70,915 crore of Tickertape and reported SCALE_MISMATCH on
      // every field of every symbol.
      //
      // That verdict is a HARD BLOCK on arming the switchover, and it was FALSE —
      // the gate reading "the units disagree" while the only disagreement was
      // this script's own. A gate that cannot pass is not a safe gate; it is one
      // that will eventually be overridden by someone who assumes it is noise.
      //
      // The flattening now reads the SAME crore statements the write plan and the
      // scale detector were handed, so all three judge one set of numbers.
      const flat: Partial<Record<Field, number>> = {};
      for (const statement of statements) {
        for (const field of FIELDS) {
          const v = statement[field];
          if (typeof v === "number") flat[field] = v;
        }
      }

      // From the eligibility VERDICT, not re-derived — the writer's own target
      // tuple is what the incumbent join must use (MONEY-1237).
      const target = targetOf.get(f.id);
      if (!target) continue; // unreachable: only eligible filings are grouped
      const label = target.period;
      const pt = target.periodType;

      // ── The scale quarantine, asked of the writer's own detector ──
      //
      // MONEY-1235. The writer refuses a filing whose magnitudes disagree with the
      // company's other filings by a power of ten (`refusedScaleSuspect`), and it
      // never auto-corrects one — multiplying by an inferred factor guesses which
      // side is wrong, and a silently "corrected" number is worse than a visible
      // gap. A value the writer will NEVER write cannot be a defect in the value
      // the writer writes, so grading it as a blocking SCALE_MISMATCH keeps the
      // gate shut on a problem that is already handled.
      //
      // Judged for every winner, including those with no vendor row, because the
      // recall question — how much of the known 28 does this catch — can only be
      // answered against the whole population.
      const candidate = observations.get(f.id);
      // AUTHORITATIVE verdict from the SCOPED context — what the nightly writer
      // will actually decide. The unscoped verdict is computed only to report how
      // often the two differ; it never quarantines.
      const scale = candidate
        ? judgeFilingScale(
            candidate,
            bySymbolScoped.get(scopeKey(f.symbol, f.periodType)) ?? [],
          )
        : null;
      const scaleUnscoped = candidate
        ? judgeFilingScale(candidate, bySymbol.get(f.symbol) ?? [])
        : null;
      if (scale && scaleUnscoped && scale.verdict !== scaleUnscoped.verdict) {
        scopeDivergence++;
      }
      {
        const n =
          (bySymbolScoped.get(scopeKey(f.symbol, f.periodType))?.length ?? 1) -
          1;
        const bucket =
          n === 0 ? "0" : n === 1 ? "1" : n === 2 ? "2" : n <= 5 ? "3-5" : "6+";
        siblingDistribution.set(
          bucket,
          (siblingDistribution.get(bucket) ?? 0) + 1,
        );
      }
      if (scale?.verdict === "INSUFFICIENT_CONTEXT") {
        insufficientReasons.set(
          scale.reason,
          (insufficientReasons.get(scale.reason) ?? 0) + 1,
        );
        if (scale.reason === "CANDIDATE_NOT_IN_CONTEXT")
          candidateNotInContext++;
      }
      if (scale) scaleJudgements.set(f.id, scale);
      // BOTH quarantining verdicts — MONEY-1250. `SCALE_BASIS_CONFLICT` is the
      // cross-basis paid-up-capital invariant; the writer REFUSES those groups
      // (`refusedBasisConflict`). A gate that graded them would score 155 periods
      // the writer will never write, which is the drift this file exists to catch.
      const quarantined =
        scale?.verdict === "SCALE_SUSPECT" ||
        scale?.verdict === "SCALE_BASIS_CONFLICT";
      if (quarantined) {
        quarantinedPeriods++;
        // The two verdicts carry DIFFERENT shapes, deliberately, and the type
        // system caught the conflation — MONEY-1250. `SCALE_SUSPECT` names a
        // power of ten (`factor`); `SCALE_BASIS_CONFLICT` has NO `factor` and
        // carries `ratio` + `undecidable` instead, precisely because it cannot
        // say which of the two filings is wrong or whether the whole filing is
        // mis-scaled. Printing a bare factor for it would read as an instruction
        // to multiply, which is the one thing the verdict refuses to assert.
        const bucket =
          scale.verdict === "SCALE_SUSPECT"
            ? scale.factor
            : "basis-conflict (undecidable)";
        quarantineFactors.set(bucket, (quarantineFactors.get(bucket) ?? 0) + 1);
      }

      const at = (
        st: "INCOME" | "BALANCE_SHEET",
      ): IncumbentFinancialsRow | undefined =>
        incumbents.get(
          `${f.symbol}\u0000${f.exchange}\u0000${pt}\u0000${label}\u0000${st}`,
        );
      const incomeRow = at("INCOME");
      const balanceRow = at("BALANCE_SHEET");
      const incumbent = incomeRow ?? balanceRow;

      if (!incumbent) {
        // No Tickertape row for this period. Counted, not compared — XBRL filling
        // a period the incumbent never had is a COVERAGE WIN, and folding it into
        // the comparison population would make the source look worse the more new
        // ground it breaks.
        //
        // Unless it is quarantined, in which case it is not a coverage win either:
        // the writer refuses it, so the period stays empty. Counted apart so
        // "coverage gain" keeps meaning ground we will actually take.
        if (quarantined) quarantinedNoVendor++;
        else noIncumbent++;
        continue;
      }
      if (quarantined) quarantinedWithVendor++;
      // Per ROW, not per period: a period can have an INCOME row from one source
      // and a BALANCE_SHEET row from another, and the count is quoted as rows.
      for (const row of [incomeRow, balanceRow]) {
        if (row?.source === XBRL_SOURCE) xbrlIncumbents++;
      }

      // ── What the WRITER would do with each statement — MONEY-1235 ──
      //
      // Not re-derived: `planFinancialsWrite` is called, and its verdict is the
      // exclusion. A SKIP means the incumbent SURVIVES — there is no write, so
      // there is nothing about that row to grade, and grading it measures a
      // disagreement that will never reach a reader.
      //
      // The reason that dominates is `STANDALONE_NO_DISPLACE`: a STANDALONE winner
      // may not displace a vendor row (3,208 of 10,879 winner periods, 29.5%), and
      // a holding company's standalone revenue differs from its consolidated one
      // by a MULTIPLE, so those pairs were reporting a BASIS mismatch as a
      // data-quality failure. `AUTHORITY` and `BASIS_DOWNGRADE` come along for
      // free and should both be zero here; they are counted, not assumed.
      //
      // Per STATEMENT, not per period, because the two halves get different
      // answers: a standalone filing may be refused the BALANCE_SHEET row a vendor
      // already owns while CREATING the INCOME row nobody has. Standalone beats
      // nothing; it just may not beat somebody.
      const skipOf = new Map<"INCOME" | "BALANCE_SHEET", Exclusion>();
      // Statements the writer would ACTUALLY touch — MONEY-1239.
      //
      // `!skipOf.has(...)` is NOT the same set and using it would overcount the
      // incumbent-nulling total below. `projectFinancials` returns `income: null`
      // when a filing filled none of the four income fields, so that statement
      // never reaches `planFinancialsWrite` at all: there is no plan, no skip
      // reason, and therefore no `excluded` tag — yet no write happens either and
      // the incumbent survives untouched. Only a plan whose action is CREATE or
      // UPDATE puts a row on the table.
      const wouldWrite = new Set<"INCOME" | "BALANCE_SHEET">();
      if (quarantined) {
        skipOf.set("INCOME", "QUARANTINED");
        skipOf.set("BALANCE_SHEET", "QUARANTINED");
      } else {
        const provenance = {
          periodEnd: f.periodEnd.toISOString(),
          periodType: f.periodType,
          basis: f.basis,
          cumulative: f.cumulative,
          // MUST match what the writer passes — MONEY-1236. See
          // `projectedWinners.family`: omitting this silently widens the gate's
          // owned set relative to the writer's for every banking/nbfc filing.
          ...(projectedWinners.get(f.id)?.family !== undefined
            ? { family: projectedWinners.get(f.id)!.family }
            : {}),
          // MUST match the writer — MONEY-1250. Typed as `FilerShape` rather
          // than inferred as `string`, so the two cannot drift to different
          // vocabularies without a compile error.
          filerShape: ((projectedWinners.get(f.id)?.bankCapitalPresent ?? false)
            ? "RBI_FORM_A"
            : "IND_AS") as FilerShape,
          taxonomyVersion: f.taxonomyVersion,
          ...(f.coverage !== null ? { coverage: f.coverage } : {}),
          ...(f.sourceUrl !== null ? { sourceUrl: f.sourceUrl } : {}),
        };
        for (const statement of statements) {
          const row =
            statement.statementType === "INCOME" ? incomeRow : balanceRow;
          const plan = planFinancialsWrite({
            projected: statement,
            incumbent: row ?? null,
            filing: provenance,
            unfilled,
            now: NOW,
          });
          if (plan.action === "SKIP" && plan.skipReason !== undefined) {
            skipOf.set(statement.statementType, plan.skipReason);
            plannedSkips.set(
              plan.skipReason,
              (plannedSkips.get(plan.skipReason) ?? 0) + 1,
            );
          } else if (plan.action !== "SKIP") {
            wouldWrite.add(statement.statementType);
          }
        }
      }

      // Raw concepts, in CRORES, for the translations below. `financials.values`
      // is in absolute rupees; `flat` was already converted above.
      const raw = (concept: string): number | undefined =>
        rupeesToCrores(
          (financials.values as Record<string, number | undefined>)[concept],
        );
      const otherIncome = raw("otherIncome");
      const profitBeforeTax = raw("profitBeforeTax");
      const financeCosts = raw("financeCosts");
      const profitForPeriod = raw("profitForPeriod");
      const exceptionalItems = raw("exceptionalItems");
      const depreciation = raw("depreciationAndAmortisation");

      for (const field of FIELDS) {
        const ours = flat[field];
        // Each column from the row that OWNS it. Reading `totalAssets` off the
        // INCOME row (or `revenue` off BALANCE_SHEET) yields null and scores
        // INCOMPARABLE — which is how four of six fields went unjudged.
        const row = statementOf(field) === "INCOME" ? incomeRow : balanceRow;
        const theirs = (row?.[field] as number | null | undefined) ?? undefined;

        // ── Compare the same QUANTITY, not just the same column name ──────
        //
        // MONEY-1234. The vendor's columns are different measures wearing our
        // names, and comparing them raw measures our disagreement about
        // DEFINITIONS rather than about the underlying facts. Each translation
        // below was derived by hypothesis-testing every disagreement in the
        // full annual universe on prod (2026-08-21) and is annotated with the
        // share of disagreements it accounts for.
        //
        // Our stored values do NOT change — only what the gate holds them up
        // against. `revenueFromOperations` and the owners' share of profit are
        // the right things for the product to mean; they are simply not the
        // things the vendor stored under those names.
        const alternatives: Translation[] = [];
        // ── The DECLARED other-income translation — MONEY-1239 ──
        //
        // ONE rule, applied to exactly the two fields where the vendor's column is
        // ours plus other income (`OTHER_INCOME_TRANSLATED`; `netIncome` is
        // deliberately not in it). It is FIRST in the candidate list because it is
        // the declared form — `ours + otherIncome`, both terms read off THIS
        // filing — so a pair that the declared gap explains is attributed to it
        // rather than to whichever derived hypothesis happens to land first.
        //
        // It requires `otherIncome` FROM THE SAME FILING. Absent, there is no
        // translation to try, and the pair is counted `translationUnavailable`
        // rather than as a translation that failed.
        if (
          OTHER_INCOME_TRANSLATED.has(field) &&
          ours !== undefined &&
          otherIncome !== undefined
        ) {
          // revenue:         77.9% of revenue disagreements (2,748/3,526) — their
          //                  `incTrev` is TOTAL INCOME.
          // operatingIncome: their `incPbi` is EBIT INCLUDING other income, and
          //                  ours excludes it by construction.
          alternatives.push({
            label: "ours + otherIncome",
            value: ours + otherIncome,
          });
        }
        if (
          field === "operatingIncomeExOtherIncome" &&
          profitBeforeTax !== undefined &&
          financeCosts !== undefined
        ) {
          // 73.9% of operatingIncome disagreements (3,385/4,578): their `incPbi`
          // is EBIT INCLUDING other income. Ours is EBIT excluding it — the
          // difference is `otherIncome` plus anything exceptional below the
          // `totalExpenses` line.
          alternatives.push({
            label: "PBT + FC",
            value: profitBeforeTax + financeCosts,
          });
          // "EBIT BEFORE exceptional items" is a standard published measure, and
          // the vendor uses it: of the disagreements that survived the plain EBIT
          // translation, 16.7% match `PBT + FC − exceptional` and a further 2.2%
          // match `+ exceptional` (the sign the filing gives it varies). Both
          // directions are offered because `exceptionalItems` is tagged as a
          // signed amount, not as a magnitude with a convention.
          if (exceptionalItems !== undefined) {
            alternatives.push({
              label: "PBT + FC - exceptional",
              value: profitBeforeTax + financeCosts - exceptionalItems,
            });
            alternatives.push({
              label: "PBT + FC + exceptional",
              value: profitBeforeTax + financeCosts + exceptionalItems,
            });
          }
        }
        if (
          field === "ebitdaBeforeExceptionalItems" &&
          ours !== undefined &&
          otherIncome !== undefined
        ) {
          // Their `incEbi` is an OPERATING EBITDA, excluding other income; ours
          // is PBT + finance + depreciation, which includes it.
          alternatives.push({
            label: "ours - otherIncome",
            value: ours - otherIncome,
          });
          // EBITDA BEFORE exceptional items, with and without other income —
          // 20.1% and 1.3% of the ebitda disagreements that survived the plain
          // translation. Same standard published measure as the EBIT case above.
          if (
            profitBeforeTax !== undefined &&
            financeCosts !== undefined &&
            depreciation !== undefined &&
            exceptionalItems !== undefined
          ) {
            const ebitdaRaw = profitBeforeTax + financeCosts + depreciation;
            alternatives.push({
              label: "EBITDA - exceptional",
              value: ebitdaRaw - exceptionalItems,
            });
            // THE VENDOR IS USUALLY RAW — MONEY-1239, measured after the writer
            // changed under this gate.
            //
            // `projectFinancials` now REMOVES exceptional items from `ebitda`
            // (a -30,711 Cr AGR provision was turning a +8,928 Cr EBITDA into
            // -21,783 — a sign flip feeding `ebitdaMargin` at -103%). Screener
            // excludes them too. But `ebitdaRaw` above is recomputed from the
            // FACTS, so the translation beside it was offering the ADJUSTED value
            // as a candidate for THEIRS — which the 20.1% figure in the comment
            // says is true only sometimes.
            //
            // Measured against prod the moment the writer changed: the ebitda
            // disagreement rate went 24.0% -> 40.4% and `matched` fell 108 -> 86.
            // 3IINFOLTD FY2024 is the clean read — theirs is -262.02, which is
            // exactly PBT(-299) + interest(10) + depreciation(27). The vendor
            // carries the exceptional item; we now do not.
            //
            // So the missing candidate is the OTHER direction: our adjusted value
            // put back to raw. Declared here rather than reverted in the writer,
            // for the same reason as the other-income axis — our number is the
            // analytically defensible one, and the gate's job is to say how the
            // vendor's differs, not to make the writer imitate it.
            alternatives.push({
              label: "ours + exceptional (the vendor's raw EBITDA)",
              value: ours + exceptionalItems,
            });
            alternatives.push({
              label: "EBITDA - otherIncome - exceptional",
              value: ebitdaRaw - otherIncome - exceptionalItems,
            });
          }
        }
        if (field === "netIncome" && profitForPeriod !== undefined) {
          // 12.0% of netIncome disagreements: the vendor stores the TOTAL for the
          // period, where ours is deliberately the owners' share.
          alternatives.push({
            label: "profitForPeriod (total, not owners' share)",
            value: profitForPeriod,
          });
        }
        // DELIBERATELY NOT TRANSLATED — `revenue + otherIncome + exceptionalItems`
        // fits 37.3% of the revenue disagreements that survive the translation
        // above, and it is left on the table anyway.
        //
        // "Total income net of an exceptional charge" is not a quantity anyone
        // publishes as REVENUE: Ind-AS puts exceptional items on their own line
        // BELOW total income. Adding terms until the residual fits is the same
        // move as widening the tolerance until the gate passes, and this ladder
        // exists to prevent exactly that. If the vendor genuinely computes revenue
        // that way it is worth establishing from their documentation — not
        // inferring it because the arithmetic happens to land.

        // THE LADDER'S ORDERING, and it is load-bearing:
        //
        //     SCALE  >  SIGN  >  TRANSLATION  >  DISAGREE
        //
        // The primary comparison decides the verdict; a translation may only
        // UPGRADE it. It can never turn a match into a disagreement, and it can
        // never mask a SCALE error — those are returned by the primary call and
        // left alone, because a units bug is systematic and must not be explained
        // away by trying a different quantity. A SIGN flag sits between the two:
        // it is examined before a translation is allowed to resolve it, and only
        // a TIGHT match under the same tolerance resolves it (MONEY-1237).
        //
        // What MONEY-1239 changes is the NAME the report gives the result, not
        // the ordering and not the verdict: `r.verdict` still becomes MATCH and
        // still goes to `judgeSwitchoverReadiness` unchanged, while
        // `classification` records TRANSLATED so the printed ladder can show
        // "matched N, translated M, disagreed K" instead of one merged figure.
        let r = reconcile(ours, theirs, {
          absoluteEpsilon: ABSOLUTE_EPSILON_CR,
        });
        let translated = false;
        let translatedBy: string | undefined;
        let signResolvedByTranslation = false;
        // SIGN now also tries the translations — MONEY-1237. The prior rule ("a
        // translation can never mask a SIGN error") was refuted by its own data:
        // BOMDYEING FY2021 scored SIGN_MISMATCH — ours (rev − totExp + FC) = −8.22
        // vs vendor +81.82 — while the vendor's value equals its own declared
        // definition, PBT + FC = 81.85, to 0.04%. Near breakeven, an operations-only
        // figure and an other-income-inclusive one legitimately sit on opposite
        // sides of zero; flagging that as a systematic sign-convention error blocks
        // the ladder on a definitional artefact.
        //
        // SCALE stays pre-empting: a power-of-ten gap must never be laundered by
        // trying a different quantity. The guard that keeps the sign relaxation
        // honest is that the translation must produce a REAL match under the same
        // tight tolerance — a GENUINE sign bug (a loss stored as a positive
        // magnitude) has |theirs| ≈ |ours| and matches no definitional candidate,
        // so it still classifies SIGN_MISMATCH. MODIRUBBER FY2025 does exactly
        // that: vendor +23.92 matches no candidate and stays flagged. Resolved
        // pairs are counted separately so the report shows how many sign flags
        // were definitional rather than silently absorbing them.
        let translationUnavailable = false;
        if (r.verdict === "DISAGREEMENT" || r.verdict === "SIGN_MISMATCH") {
          const primaryWasSign = r.verdict === "SIGN_MISMATCH";
          for (const candidate of alternatives) {
            const alt = reconcile(candidate.value, theirs, {
              absoluteEpsilon: ABSOLUTE_EPSILON_CR,
            });
            if (alt.verdict === "MATCH") {
              r = alt;
              translated = true;
              translatedBy = candidate.label;
              signResolvedByTranslation = primaryWasSign;
              break;
            }
          }
          // COULD NOT DETERMINE, kept apart from DID NOT AGREE — MONEY-1239.
          //
          // A field whose vendor column is ours plus other income cannot be
          // tested at all when the filing discloses no `otherIncome`. Folding
          // that into "the translation did not resolve it" asserts something the
          // run never measured, and this repo's standing rule is that "couldn't
          // determine" gets its own value. Such a pair still counts as a
          // DISAGREEMENT in the ladder — it is not a match and must not be
          // treated as one — it is only reported apart.
          if (
            !translated &&
            OTHER_INCOME_TRANSLATED.has(field) &&
            otherIncome === undefined
          ) {
            translationUnavailable = true;
          }
        }
        if (translated) translatedMatches++;
        if (translatedBy !== undefined) {
          translationLabels.set(
            translatedBy,
            (translationLabels.get(translatedBy) ?? 0) + 1,
          );
        }
        if (signResolvedByTranslation) signTranslations++;

        // Pushed EVEN WHEN EXCLUDED, tagged rather than dropped. Two reasons, and
        // the second is the load-bearing one: the report has to be able to say how
        // many comparisons each exclusion removed and what their verdicts were,
        // and the detector's RECALL against the 28 known scale mismatches is only
        // computable if the caught ones are still in the list. A `continue` here
        // would make the gate quieter and unfalsifiable at the same time.
        //
        // TWO VARIABLES, NOT ONE — MONEY-1255, and conflating them is a real
        // defect rather than a tidiness point.
        //
        // `writerSkip` is what the WRITER refuses. `excluded` is what the LADDER
        // does not grade, which is the writer's refusals PLUS this run's symbol
        // exclusions. They used to be the same value because every exclusion was
        // a writer refusal; `SYMBOL_EXCLUDED` is not, and the difference lands
        // squarely on `nullsIncumbent` below: that count asks "would arming
        // replace a populated vendor value with NULL", and for an excluded SYMBOL
        // the answer is still YES — the writer writes it regardless of what this
        // gate chose to grade. Keying that block on `excluded` would have
        // silently stopped counting incumbent destruction for exactly the four
        // symbols we already know are wrong.
        //
        // The writer's refusal is checked FIRST so a row that is already
        // quarantined or planner-skipped is attributed to THAT, not to the symbol
        // list. Otherwise the symbol tally would claim credit for removals the
        // writer had already made, which is the one way this list can overstate
        // what it bought.
        const writerSkip = skipOf.get(statementOf(field));
        const excluded: Exclusion | undefined =
          writerSkip ??
          (EXCLUDED_SYMBOL_SET.has(f.symbol) ? "SYMBOL_EXCLUDED" : undefined);
        // INCUMBENT-NULLING — MONEY-1239.
        //
        // `projectedValues` emits `null` for every OWNED field the projection
        // could not fill, and all six fields here are owned, so an UPDATE with an
        // absent value REPLACES the vendor's number with an empty cell. The
        // ladder cannot see this: a blank on our side reads INCOMPARABLE, which
        // is excluded from the rate's denominator by design, so no field's
        // disagreement rate moves and nothing blocks. It has to be counted
        // explicitly or it is invisible until after the one-way door.
        //
        // Three conditions, all required. `writerSkip === undefined` because a
        // SKIP leaves the incumbent alone; `wouldWrite.has(...)` because a
        // statement the projection returned as null never reaches the planner and
        // is not a write either; and a populated vendor value, because nulling an
        // already empty cell costs nothing.
        //
        // `writerSkip`, NOT `excluded` — MONEY-1255. A SYMBOL_EXCLUDED row is one
        // the writer still writes; only this gate declined to grade it. The
        // damage it does to an incumbent is unchanged by our choosing not to look
        // at it, and this block exists precisely because that damage is invisible
        // to the ladder.
        // FIELD-aware, not just statement-aware — MONEY-1239. `wouldWrite` says
        // the STATEMENT is written; it does not say this COLUMN is. A lender does
        // not own `operatingIncome` or `ebitda` (the concepts they need are in
        // 10% and 0% of lender filings), so the write never mentions them and the
        // vendor's value is untouched. Counting those as "nulled" would report a
        // loss that no longer happens — and this block exists precisely because
        // the ladder cannot see this class, so it has to be right.
        const writable = writableFields(
          statementOf(field),
          financials.family as XbrlFinancials["family"],
          filerShapeOf(financials.values),
        );
        const nullsIncumbent =
          ours === undefined &&
          theirs !== undefined &&
          writerSkip === undefined &&
          wouldWrite.has(statementOf(field)) &&
          (writable as readonly string[]).includes(field);
        comparisons.push({
          symbol: f.symbol,
          period: label,
          filingId: f.id,
          basis: f.basis,
          field,
          ours,
          theirs: theirs ?? undefined,
          verdict: r.verdict,
          classification: translated ? "TRANSLATED" : r.verdict,
          ...(translatedBy !== undefined ? { translatedBy } : {}),
          ...(signResolvedByTranslation
            ? { signResolvedByTranslation: true as const }
            : {}),
          ...(translationUnavailable ? { translationUnavailable: true } : {}),
          ...(nullsIncumbent ? { nullsIncumbent: true } : {}),
          ...(r.relativeDiff !== undefined
            ? { relativeDiff: r.relativeDiff }
            : {}),
          ...(r.scaleFactor !== undefined
            ? { scaleFactor: r.scaleFactor }
            : {}),
          ...(excluded !== undefined ? { excluded } : {}),
        });
      }
    }
  }

  // ── The read, one page of SYMBOLS at a time — MONEY-1287 ────────────
  //
  // `prisma.xbrlFiling` is handed through `SymbolPagedFilings`, which is why it
  // needs the cast: the generated delegate's `findMany` is a heavily overloaded
  // generic that will not structurally satisfy a plain args object, and the
  // pager only ever needs the four keys the interface names. Same shape as
  // `ScreenerDeps["prisma"]`, and the same `as unknown as`.
  const pageStats = await readFilingsBySymbolPage(
    prisma.xbrlFiling as unknown as SymbolPagedFilings<FilingRow>,
    { where, select: FILING_SELECT, limit: LIMIT, pageSize: SYMBOL_PAGE_SIZE },
    processPage,
  );

  if (pageStats.filings === 0) {
    // A zero here is NOT a clean bill of health — it means the backfill has not
    // run. Saying so explicitly, because "0 disagreements" is exactly what a
    // successful reconciliation also prints.
    log.warn(
      "NO XbrlFiling rows matched. This is not a passing reconciliation — it " +
        "means there is nothing to reconcile. Run the P10 F2 backfill first " +
        "(./scripts/ops/run-market-data-job.sh xbrl prod --apply).",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // ── The census, printed ONCE over every page ────────────────────────
  //
  // Order preserved from before the paging: refusals, then the population, then
  // the scale context, then the incumbent load. These describe the WHOLE run —
  // printing them per page would turn a census a reader acts on into a progress
  // log, and the last page's numbers would be the ones left on the screen.
  log.info(
    `read ${pageStats.filings} filing(s) across ${pageStats.symbols} symbol(s) ` +
      `in ${pageStats.pages} page(s) of ${SYMBOL_PAGE_SIZE} symbol(s) (+1 census ` +
      `query)` +
      (LIMIT ? ` — capped by --limit=${LIMIT}` : ""),
  );
  if (refusalCounts.size > 0) {
    log.info(
      `writer-mirrored refusals (never grouped, never counted as coverage): ` +
        [...refusalCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} ${n}`)
          .join(", "),
    );
  }
  log.info(
    `reconciling ${totalWinners} period(s) from ${totalFilings} filing(s)` +
      (totalSuperseded > 0
        ? ` — ${totalSuperseded} sibling(s) superseded (CONSOLIDATED beats STANDALONE), ` +
          `matching what xbrl-projection-writer would actually persist`
        : ""),
  );
  log.info(
    `scale context: ${totalObservations} observation(s) across ${totalObservedSymbols} ` +
      `symbol(s) (the detector needs 3+ comparable siblings before it will judge)`,
  );
  log.info(
    `loaded ${incumbentRowsLoaded} incumbent row(s) for ${incumbentSymbols} symbol(s) ` +
      `in ${incumbentQueries} quer(ies)`,
  );

  // ── Report ──
  //
  // GRADED vs EXCLUDED — MONEY-1235. A comparison the writer would never
  // perform is not evidence about the writer, so it leaves the ladder. It does
  // NOT leave the report: an exclusion that is only visible as a smaller
  // denominator is indistinguishable from a defect nobody found, and this
  // script's whole reason for existing is that the switchover is a one-way door.
  const graded = comparisons.filter((c) => c.excluded === undefined);
  const excludedRows = comparisons.filter((c) => c.excluded !== undefined);

  const byField = new Map<Field, ReconcileVerdict[]>();
  /** Per field, how many GRADED pairs carry an incumbent value. */
  const incumbentSeen = new Map<Field, number>();
  /**
   * The SAME verdicts with every translation demoted back to DISAGREEMENT —
   * MONEY-1239. Not a second gate: it is the counterfactual the founder needs
   * in order to own the threshold decision, judged by the same function with
   * the same defaults so the two numbers are directly comparable. `allReady` is
   * NEVER computed from it.
   */
  const byFieldStrict = new Map<Field, ReconcileVerdict[]>();
  const translationsByField = new Map<Field, FieldTranslations>();
  for (const c of graded) {
    const list = byField.get(c.field) ?? [];
    list.push(c.verdict);
    byField.set(c.field, list);
    // Whether the INCUMBENT has a value, per field — MONEY-1250. `incomparable`
    // cannot answer this: it means ONE SIDE had no value, and does not say
    // which. See `unverifiable` below for why the difference is the whole
    // safety of that exemption.
    if (c.theirs !== undefined)
      incumbentSeen.set(c.field, (incumbentSeen.get(c.field) ?? 0) + 1);
    const strict = byFieldStrict.get(c.field) ?? [];
    // Demote to the verdict the pair ACTUALLY HELD before translation — which
    // for a sign-rescued pair is SIGN_MISMATCH, not DISAGREEMENT. See
    // `Comparison.signResolvedByTranslation`: the judge blocks unconditionally
    // on a sign mismatch, so collapsing the two makes this counterfactual
    // permissive about the one verdict that is not negotiable.
    strict.push(
      c.classification === "TRANSLATED"
        ? c.signResolvedByTranslation
          ? "SIGN_MISMATCH"
          : "DISAGREEMENT"
        : c.verdict,
    );
    byFieldStrict.set(c.field, strict);
    const t = translationsByField.get(c.field) ?? emptyFieldTranslations();
    if (c.classification === "TRANSLATED") t.translated++;
    if (c.translationUnavailable) t.unavailable++;
    translationsByField.set(c.field, t);
  }
  const excludedByField = new Map<Field, FieldExclusions>();
  for (const c of excludedRows) {
    const reason = c.excluded;
    if (reason === undefined) continue;
    const e = excludedByField.get(c.field) ?? emptyFieldExclusions();
    e.total++;
    // COMPARABLE, not total: a pair with a blank on one side was never in the
    // rate's denominator, so removing it changes nothing and counting it as a
    // removal would overstate what the exclusion cost.
    if (c.verdict !== "INCOMPARABLE") e.comparable++;
    if (c.verdict === "SCALE_MISMATCH") e.scale++;
    if (c.verdict === "SIGN_MISMATCH") e.sign++;
    if (c.verdict === "DISAGREEMENT") e.disagree++;
    e.byReason.set(reason, (e.byReason.get(reason) ?? 0) + 1);
    excludedByField.set(c.field, e);
  }

  // ── WHICH SIDE of each INCOMPARABLE pair was empty — MONEY-1250 ─────
  //
  // The ticket that produced this block asked whether ~31 CONSOLIDATED FY2025
  // filings were missing from NSE or only from our archive. Measured: NEITHER
  // is what the balance sheet's `comparable 2555 of 4744` is about. 403 of the
  // 419 standalone-only FY2025 symbols have NO consolidated filing at NSE at
  // all — they are single-entity companies with nothing to consolidate, and
  // that is the CORRECT state, not a gap. What the 2,189-pair shortfall
  // actually is: 2,165 pairs where OUR side has no value, every one of them
  // FY2020-FY2022, every one on a `_WEB.xml` document that carries no balance
  // sheet section at all.
  //
  // None of that was visible. The ladder prints one `incomparable` count and
  // INCOMPARABLE is outside the disagreement rate by design (MONEY-1196), so a
  // reader before a ONE-WAY DOOR saw a denominator that had halved and no
  // statement of why — the same shape as the exclusions before MONEY-1235 gave
  // them a printed line, and the same remedy.
  const incomparableByField = new Map<Field, Comparison[]>();
  for (const c of graded) {
    if (c.verdict !== "INCOMPARABLE") continue;
    const a = incomparableByField.get(c.field) ?? [];
    a.push(c);
    incomparableByField.set(c.field, a);
  }
  const blanksByField = new Map<Field, IncomparableSplit>();
  /** Of the OURS-BLANK pairs, how many had a STANDALONE winner. */
  const oursBlankStandalone = new Map<Field, number>();
  // ONE definition of "ours blank", and it is the tested one. A local
  // `c.ours === undefined` here would be a second predicate that agrees with
  // `splitIncomparable` today and drifts the first time either learns about a
  // new kind of absent value — which is exactly how the two copies of the basis
  // ordering `basisRank` was extracted for came to disagree.
  const isOursBlank = (c: Comparison): boolean =>
    classifyIncomparable(c) === "OURS_BLANK";
  for (const [field, rows] of incomparableByField) {
    blanksByField.set(field, splitIncomparable(rows));
    oursBlankStandalone.set(
      field,
      rows.filter((c) => c.basis !== "CONSOLIDATED" && isOursBlank(c)).length,
    );
  }

  const histogram = (m: ReadonlyMap<number | string, number>): string =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      // A numeric key IS a factor and reads as "100x:6". A string key is a
      // named bucket that has no factor — `SCALE_BASIS_CONFLICT` — and must NOT
      // acquire an "x" suffix, which would present an undecidable conflict as a
      // multiplier someone could act on. MONEY-1250.
      .map(([f, n]) => (typeof f === "number" ? `${f}x:${n}` : `${f}:${n}`))
      .join(", ");

  log.info("");
  log.info(
    `periods XBRL covers that Tickertape does NOT: ${noIncumbent} ` +
      `(coverage gain, deliberately excluded from the comparison population)`,
  );

  // ── Quarantine, as its own bucket rather than as a blocking defect ──
  const quarantinedComparisons = excludedRows.filter(
    (c) => c.excluded === "QUARANTINED",
  ).length;
  log.info(
    `QUARANTINED by the scale detector: ${quarantinedPeriods} period(s) — ` +
      `${quarantinedWithVendor} with a vendor row (${quarantinedComparisons} ` +
      `comparison(s) left the denominators), ${quarantinedNoVendor} without` +
      (quarantineFactors.size > 0
        ? ` — inferred factors ${histogram(quarantineFactors)}`
        : ""),
  );
  log.info(
    `  These are NOT fixed and NOT written. \`judgeFilingScale\` says the ` +
      `filing's own magnitudes disagree with the same company's other filings ` +
      `by a power of ten; the writer refuses it (\`refusedScaleSuspect\`) and ` +
      `never multiplies by an inferred factor, so the period stays EMPTY until ` +
      `a corrected filing arrives as a new, unstamped \`XbrlFiling\` row.`,
  );

  // ── What `planFinancialsWrite` itself would refuse ──
  log.info("");
  if (plannedSkips.size > 0) {
    log.info(
      "statements the WRITER would not write (planFinancialsWrite), so the " +
        "incumbent survives and there is nothing to grade:",
    );
    for (const [reason, n] of [...plannedSkips.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      log.info(`  ${reason.padEnd(24)} ${n} statement(s)`);
    }
  } else {
    log.info(
      "statements the WRITER would not write: NONE — and that is a finding, " +
        "not a clean bill of health.",
    );
  }
  if ((plannedSkips.get("STANDALONE_NO_DISPLACE") ?? 0) === 0) {
    // A zero here is the shape MONEY-1220 called "merged ≠ wired". 3,208 of
    // 10,879 winner periods were measured standalone-only on 2026-08-21, so the
    // expected value is thousands. Zero means the mirror is not reaching the
    // planner — not that the population changed overnight.
    //
    // BUT THAT IS A CENSUS FIGURE, NOT AN INVARIANT — MONEY-1236. It holds for
    // the full prod population and for nothing else. Two runs contradict it
    // legitimately, and both are runs we deliberately perform:
    //
    //   - a `--symbols=` / `--limit=` run, which is the shape the switchover
    //     runbook prescribes for the `createMissing` pilot;
    //   - ANY QA run, where there are no vendor incumbents at all, so every
    //     plan is a CREATE and there is nothing to decline to displace.
    //
    // Tripping on either exits 1 with no field blocked, which reads as "the
    // gate says no" when the gate has not evaluated anything.
    if (RUN_IS_SCOPED) {
      log.info(
        `ZERO STANDALONE_NO_DISPLACE skips — expected on a SCOPED run ` +
          `(${SYMBOLS.length > 0 ? `--symbols=${SYMBOLS.join(",")}` : `--limit=${LIMIT}`}). ` +
          `The thousands-expected figure is a full-population census, so it is ` +
          `not asserted here.`,
      );
      // `incumbentRowsLoaded`, summed over every page — MONEY-1287. This was
      // `incumbents.size`, a map that is now page-local. Reading the LAST
      // page's map here would be the draining-denominator shape all over
      // again: a final page with no vendor rows would print the QA line —
      // "every plan is a CREATE" — over a full prod run that loaded tens of
      // thousands of them, and the diverged-mirror warning below would never
      // fire.
    } else if (incumbentRowsLoaded === 0) {
      log.info(
        `ZERO STANDALONE_NO_DISPLACE skips, and ZERO incumbent rows. Every plan ` +
          `is a CREATE, so there is nothing to decline to displace — the QA ` +
          `shape, not a broken mirror.`,
      );
    } else {
      log.warn(
        `ZERO STANDALONE_NO_DISPLACE skips against ${incumbentRowsLoaded} incumbent ` +
          `row(s). 3,208 of 10,879 winner periods were measured standalone-only ` +
          `on 2026-08-21, so this should be in the thousands. A zero means the ` +
          `guard is not being reached, not that the population changed. Do not ` +
          `read the ladder below until this is explained.`,
      );
      standaloneMirrorDiverged = true;
    }
  }
  if (xbrlIncumbents > 0) {
    // The gate's premise is that the incumbent is a VENDOR value about to be
    // destroyed. Where the incumbent is already ours, the comparison is XBRL
    // against XBRL — a tautological MATCH that inflates every rate — and
    // `BASIS_DOWNGRADE` would need the `rawData` this query does not fetch.
    log.warn(
      `${xbrlIncumbents} incumbent row(s) are ALREADY stamped ${XBRL_SOURCE}. ` +
        `Those comparisons hold XBRL against itself and cannot fail; the match ` +
        `rates below are inflated by exactly that many pairs. Re-run against an ` +
        `environment where the projection has not been armed, or subtract them ` +
        `before believing a READY.`,
    );
  }

  // Reported, not hidden. This is the size of the DEFINITIONAL gap between the
  // two sources — pairs that only agreed once the vendor's own quantity was
  // reconstructed. If this number ever collapses, either the vendor changed
  // what it stores or a translation stopped applying, and both are worth
  // noticing before the match rate is believed.
  log.info(
    `agreed only after matching the vendor's DEFINITION: ${translatedMatches} ` +
      `(their totalIncome/EBIT/operating-EBITDA vs our operations-only figures)`,
  );
  if (translationLabels.size > 0) {
    // WHICH quantity carried each one — MONEY-1239. A bare total cannot
    // distinguish "the declared other-income gap explains nearly all of it"
    // from "five fallback hypotheses split it between them", and only the first
    // of those is a definitional difference we understand well enough to arm
    // through. Every label names a quantity built from concepts read off the
    // SAME filing; none is a fitted constant, which is the line between a
    // translation and moving the goalposts.
    log.info(
      `  by reconstruction: ` +
        [...translationLabels.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} ${n}`)
          .join(", "),
    );
  }
  if (signTranslations > 0) {
    log.info(
      `  of which ${signTranslations} had OPPOSITE SIGNS on the primary ` +
        `comparison — near-breakeven definitional differences, not sign bugs; ` +
        `a genuine sign bug matches no definitional candidate and still blocks.`,
    );
  }

  // ── Does the detector actually catch the defect it was built for? ──
  //
  // The honest question, and the one a reader will not ask on their own. The 28
  // scale mismatches of 2026-08-21 are the ONLY sample where a second source can
  // adjudicate, so this cross-tab is the detector's entire measurable recall. It
  // is expected to be partial: `MIN_SIBLING_PERIODS` is 3, and a symbol with two
  // filings has no oracle at all.
  //
  // The number is PRINTED, never targeted. Tuning `LOG10_THRESHOLD` or
  // `MIN_SIBLING_PERIODS` until this reads well would fit the detector to
  // fifteen filings and leave it protecting nothing across the 90.7% of periods
  // with no vendor row — which is the population it was built for.
  const scaleRows = comparisons.filter((c) => c.verdict === "SCALE_MISMATCH");
  if (scaleRows.length > 0 || quarantinedPeriods > 0) {
    const scaleFilings = new Map<string, { label: string; caught: boolean }>();
    for (const c of scaleRows) {
      const caught = c.excluded === "QUARANTINED";
      const prev = scaleFilings.get(c.filingId);
      if (prev) prev.caught = prev.caught || caught;
      else
        scaleFilings.set(c.filingId, {
          label: `${c.symbol} ${c.period}`,
          caught,
        });
    }
    const caughtRows = scaleRows.filter(
      (c) => c.excluded === "QUARANTINED",
    ).length;
    const missed = [...scaleFilings.entries()].filter(([, v]) => !v.caught);
    const caughtFilings = scaleFilings.size - missed.length;

    log.info("");
    log.info("detector vs the vendor overlap — measurable recall:");
    log.info(
      `  vendor-visible SCALE_MISMATCH: ${scaleRows.length} comparison(s) ` +
        `across ${scaleFilings.size} (symbol, period) filing(s)`,
    );
    log.info(
      `  caught by the detector:        ${caughtRows} comparison(s) across ` +
        `${caughtFilings} filing(s)`,
    );
    log.info(
      `  missed:                        ${scaleRows.length - caughtRows} ` +
        `comparison(s) across ${missed.length} filing(s)`,
    );
    for (const [id, v] of missed.slice(0, VERBOSE ? 200 : 15)) {
      // WHY it was missed, per filing. "INSUFFICIENT_CONTEXT (2 siblings)" and
      // "OK (9 siblings)" are different problems: the first is coverage the
      // backfill can close, the second is the detector disagreeing with the
      // vendor and needs a human.
      const j = scaleJudgements.get(id);
      log.info(
        `    ${v.label.padEnd(26)} ` +
          (j
            ? `${j.verdict} (${j.siblingPeriods} sibling period(s))`
            : "no observation — facts unreadable"),
      );
    }
    if (!VERBOSE && missed.length > 15) {
      log.info(`    … ${missed.length - 15} more; re-run with --verbose`);
    }
    if (scaleFilings.size > 0) {
      const recall = caughtFilings / scaleFilings.size;
      log.info(
        `  recall over the vendor-visible population: ` +
          `${(recall * 100).toFixed(0)}% (${caughtFilings}/${scaleFilings.size} filing(s))`,
      );
      if (recall < 0.5) {
        log.info(
          `  BELOW HALF — say it plainly: the detector is not a substitute for ` +
            `the vendor overlap on this population. The misses above are still ` +
            `in the ladder and still BLOCK, which is the correct outcome. Do NOT ` +
            `raise this by loosening MIN_SIBLING_PERIODS or LOG10_THRESHOLD; ` +
            `those constants were derived from a fixture, and refitting them to ` +
            `fifteen filings buys a number here and costs protection everywhere ` +
            `else. Recommended: understand each surviving miss individually, or ` +
            `arm with those symbols excluded.`,
        );
      }
    }

    log.info(
      `  quarantined WITHOUT a vendor-visible mismatch: ` +
        `${quarantinedPeriods - caughtFilings} filing(s) — periods where the ` +
        `vendor could not have raised the alarm at all, either because it has ` +
        `no row for them (90.7% of winner periods) or because its row did not ` +
        `read as SCALE_MISMATCH. This is the cover the overlap could never have ` +
        `provided, and it is the whole reason the detector is vendor-free.`,
    );
  }

  log.info("");
  // Printed UNCONDITIONALLY — MONEY-1237. These two lines used to sit inside
  // the quarantine-summary branch, so on the CLEAN run an operator uses to
  // decide READY, the line saying which filings the detector cannot protect
  // was not printed at all. "0 quarantines" must be distinguishable between
  // "the detector cleared every winner" and "the detector had 0-1 siblings for
  // every winner and answered INSUFFICIENT_CONTEXT across the board" — that
  // detector is the entire argument for arming despite 90.7% vendor
  // non-coverage.
  log.info(
    `  scoped-vs-unscoped context: ${scopeDivergence} verdict(s) would CHANGE ` +
      `if the detector saw the whole symbol history instead of the writer's ` +
      `ANNUAL-scoped nightly page. Non-zero is expected during the drain (which ` +
      `runs whole symbols); it is the measured size of that difference, not a bug.`,
  );
  if (insufficientReasons.size > 0) {
    log.info(
      `  INSUFFICIENT_CONTEXT by cause: ` +
        [...insufficientReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r}:${n}`)
          .join("  ") +
        ` — NO_SIBLINGS is the benign case (a first-ever filer). ` +
        `CANDIDATE_NOT_IN_CONTEXT is a CALLER BUG and blocks readiness.`,
    );
  }
  if (candidateNotInContext > 0) {
    log.error(
      `  CANDIDATE_NOT_IN_CONTEXT on ${candidateNotInContext} winner(s). The ` +
        `scale detector was handed a context that does not contain the filing ` +
        `it was asked to judge, so the quarantine is OFF for those filings — ` +
        `and it reads as "not enough history", which is why this went unnoticed ` +
        `for the whole quarterly population. Fix the context scoping before ` +
        `reading any readiness verdict from this run.`,
    );
  }
  log.info(
    `  scoped sibling counts per winner: ` +
      ["0", "1", "2", "3-5", "6+"]
        .map((b) => `${b}:${siblingDistribution.get(b) ?? 0}`)
        .join("  ") +
      ` — "0" and "1" answer INSUFFICIENT_CONTEXT, i.e. filings the detector ` +
      `cannot protect under the nightly configuration.`,
  );

  // ── SYMBOL EXCLUSIONS, printed BEFORE the ladder they alter ─────────
  //
  // MONEY-1255 (D3). Above the per-field lines on purpose: these removals
  // change what every line below says, and a disclosure that arrives after the
  // verdict is a footnote to a decision already taken. The same reasoning put
  // the contamination check into the VERDICT line in MONEY-1239.
  //
  // Printed UNCONDITIONALLY, zeros included, for the reason `tallySymbolExclusions`
  // seeds from the declared list rather than from the rows: a symbol that
  // removed nothing is the row that tells a reader the list is carrying an
  // entry this gate does not need.
  const symbolExcludedRows = comparisons.filter(
    (c) => c.excluded === "SYMBOL_EXCLUDED",
  );
  const symbolTallies = tallySymbolExclusions(
    symbolExcludedRows,
    Object.keys(EXCLUDED_SYMBOLS),
  );
  log.info("");
  log.info(
    `SYMBOL EXCLUSIONS: ${symbolExcludedRows.length} comparison(s) across ` +
      `${symbolTallies.length} declared symbol(s) removed from the ladder.`,
  );
  log.warn(
    `  THESE ARE NOT LIKE THE OTHER EXCLUSIONS. Every other exclusion in this ` +
      `report removes a comparison because THE WRITER WILL NOT PERFORM THE ` +
      `WRITE, so the incumbent survives and there is nothing to grade. These ` +
      `rows WILL be written. Removing them does not make the gate a better ` +
      `measurement of arming — it makes the gate agree to arm over a ` +
      `population already found to be wrong. Read every verdict below as ` +
      `"READY EXCEPT FOR THESE".`,
  );
  for (const t of symbolTallies) {
    log.info(
      `  ${t.symbol.padEnd(12)} removed ${t.total} comparison(s) ` +
        `(${t.comparable} comparable: matched ${t.matched}, scale ${t.scale}, ` +
        `sign ${t.sign}, disagree ${t.disagree}; incomparable ${t.incomparable})` +
        (t.fields.length > 0 ? ` across ${t.fields.join(", ")}` : ``),
    );
    log.info(`${"      "}why: ${EXCLUDED_SYMBOLS[t.symbol]}`);
    if (t.total === 0) {
      // The falsifier for the entry, and the reason the zero is printed at all.
      // Two readings, and BOTH mean the list is wrong here rather than the data
      // being clean: either something upstream (the quarantine, a planner skip)
      // already removed every row — in which case this entry buys nothing and
      // claims credit for another mechanism's work — or the symbol is simply
      // not a problem for THIS gate. Neither is a reason to leave it listed
      // silently.
      log.warn(
        `${"      "}REMOVED NOTHING. Either an upstream exclusion already took ` +
          `every row for this symbol, or it is not a defect in THIS gate at ` +
          `all. Confirm which before treating this entry as load-bearing, and ` +
          `delete it if the defect lives in the sibling ratios gate.`,
      );
    }
  }

  // ── Columns the projection does not claim — printed, not restated ────
  //
  // MONEY-1255. `UNOWNED_VENDOR_COLUMNS` is imported and printed verbatim
  // rather than summarised here, for the same reason `DECLARED_DIVERGENCES`'
  // strings are: a declaration whose evidence lives in a commit message is
  // indistinguishable from a suppression six months later.
  //
  // This is the answer to "what does a READY verdict NOT cover". These columns
  // are absent from the per-field ladder entirely — not blocked, not exempted,
  // simply not written — and nothing else in this report would tell a reader
  // that the vendor's `revenue` survives the switchover untouched.
  const unowned = Object.entries(UNOWNED_VENDOR_COLUMNS);
  if (unowned.length > 0) {
    log.info("");
    log.info(
      `VENDOR COLUMNS THE PROJECTION DOES NOT OWN: ${unowned.length}. The ` +
        `switchover never writes these, so the vendor's value survives and no ` +
        `verdict below concerns them. Our figures for the same quantities are ` +
        `written to separately-named columns, which the ladder DOES judge.`,
    );
    for (const [column, why] of unowned) {
      log.info(`  ${column.padEnd(17)} ${why}`);
    }
  }

  log.info("");
  log.info(
    `per-field readiness — the ladder judges GRADED comparisons only ` +
      `(${graded.length} of ${comparisons.length}; ${excludedRows.length} excluded, ` +
      `${excludedRows.length - symbolExcludedRows.length} because the writer would ` +
      `not perform the write and ${symbolExcludedRows.length} because the SYMBOL ` +
      `was declared out). Thresholds are judgeSwitchoverReadiness's own defaults: ` +
      `this script passes no overrides, deliberately — a gate that tunes its own ` +
      `floor is not a gate. Each blocked line names the floor it missed.`,
  );

  /** Continuation lines, indented under the field they belong to. */
  const CONT = "      ";
  let allReady = true;
  for (const field of FIELDS) {
    const verdicts = byField.get(field) ?? [];
    const v = judgeSwitchoverReadiness(verdicts);

    // UNVERIFIABLE — a column the vendor never populated, MONEY-1250.
    //
    // `otherIncome` reads `comparable 0 of 4032`: every pair is INCOMPARABLE
    // because `stock_financials` holds no TICKERTAPE value for it at all. Graded
    // as BLOCKED that is a floor no amount of work can clear, so it would hold
    // the switchover shut forever on the absence of a comparison rather than on
    // a disagreement.
    //
    // It is also the one case where the gate's whole premise does not apply.
    // This script exists because the table has no `source` in its unique key, so
    // the first XBRL write DESTROYS the incumbent. Where there is no incumbent
    // there is nothing to destroy and no door to walk through — writing the
    // column can only fill an empty cell.
    //
    // DELIBERATELY NARROW: zero comparable AND zero incumbent values seen.
    //
    // The second conjunct is load-bearing and `v.incomparable > 0` is NOT it.
    // INCOMPARABLE means ONE SIDE had no value and does not say which, so on its
    // own it cannot separate
    //
    //     ours present, theirs absent   the column is NEW      -> safe to exempt
    //     ours ABSENT,  theirs present  the writer CANNOT FILL -> destroys data
    //
    // and the second shape is the one that walks through the door: every write
    // puts an explicit NULL over a populated vendor value while the gate prints
    // "nothing for the write to destroy". That is the same indistinguishability
    // this script's own Prisma select had — a zero meaning "we never asked"
    // reading as a zero meaning "nothing to compare against" — reintroduced one
    // layer up. It is reachable without a bug, because FIELDS is now DERIVED:
    // add a column to the writer's ownership before the projection can fill it
    // and this exempts it silently.
    //
    // So it asks the question directly. A field with even ONE incumbent value
    // keeps its BLOCKED verdict — then "few comparisons" is a sampling problem,
    // and exempting it would be the draining denominator of MONEY-1196 wearing
    // a third name.
    //
    // THE ORDERING IS NOW IN `judgeFieldGateOutcome` — MONEY-1255. It was two
    // inline conditions whose precedence lived in the order they were written,
    // and D2 adds a THIRD state (DECLARED) to that shape. Three states with an
    // implicit ordering is how the ratios gate became unpassable for a release.
    // The function is pure and unit-tested, including the ordering itself; this
    // line is the only place the exemption can be applied, and `declared` is a
    // required argument there so it can never be applied by accident.
    const declaration = DECLARED_FIELD_DIVERGENCES[field];
    const outcome = judgeFieldGateOutcome({
      ready: v.ready,
      comparable: v.comparable,
      incomparable: v.incomparable,
      incumbentValuesSeen: incumbentSeen.get(field) ?? 0,
      declared: declaration !== undefined,
    });
    const unverifiable = outcome.verdict === "UNVERIFIABLE";
    if (outcome.blocks) allReady = false;
    // COMPARABLE first and by name. `matched/compared` was the old headline and
    // it is the draining-denominator reading: `compared` counts blanks, so the
    // fraction shrinks for a reason that has nothing to do with agreement.
    const rate = v.comparable > 0 ? (v.disagreements / v.comparable) * 100 : 0;
    // TRANSLATED, as its own bucket — MONEY-1239.
    //
    // `v.matched` counts MATCH verdicts and a translated pair is one of those,
    // so printing it raw is exactly the silent fold this ticket exists to
    // remove. Subtracting gives the pairs that agreed WITHOUT reconstructing
    // anything, and the three numbers then read as a shape — "matched 130,
    // translated 84, disagreed 32" — rather than as one merged figure that
    // cannot be argued with.
    const t = translationsByField.get(field) ?? emptyFieldTranslations();
    const matchedRaw = v.matched - t.translated;
    // THE CENSUS IS PRINTED FOR EVERY VERDICT, DECLARED INCLUDED — MONEY-1255.
    // Declaring is not hiding: the counts below are the same counts a BLOCKED
    // field prints, computed the same way, from the same population. A declared
    // field that stops printing them has become a suppression.
    const label = {
      READY: "READY  ",
      BLOCKED: "BLOCKED",
      UNVERIFIABLE: "UNVERIF",
      DECLARED: "DECLARE",
    }[outcome.verdict];
    log.info(
      `  ${field.padEnd(17)} ${label}  ` +
        `comparable ${v.comparable} of ${v.compared} judged, ` +
        `matched ${matchedRaw}, translated ${t.translated}, ` +
        `disagreed ${v.disagreements} (${rate.toFixed(1)}%), ` +
        `scale ${v.scaleMismatches}, sign ${v.signMismatches}, ` +
        `incomparable ${v.incomparable}`,
    );
    if (declaration !== undefined) {
      // NOT GRADED, and said in those words. The ratios gate's wording, on
      // purpose — one vocabulary for one instrument across both gates.
      log.info(
        `${CONT}DECLARED DEFINITIONAL DIVERGENCE — NOT GRADED. This run makes ` +
          `no claim about this column in EITHER direction: the census above is ` +
          `neither evidence of agreement nor of a defect, and it does not ` +
          `count toward the switchover. It does not block, and that is a ` +
          `DELIBERATE non-claim rather than a pass.`,
      );
      log.info(`${CONT}what differs: ${declaration.reason}`);
      log.info(`${CONT}how we know:  ${declaration.evidence}`);
      log.warn(
        `${CONT}COST OF THE DECLARATION: \`stock_financials\` has no \`source\` ` +
          `in its unique key, so arming REPLACES the vendor's value for this ` +
          `column on every period written — ${v.comparable} comparable pair(s) ` +
          `here, ${v.disagreements} of which disagree. Declaring records that ` +
          `we understood the difference and chose it; it does not undo it.`,
      );
      if (outcome.declarationUntested) {
        // A declaration asserts a MEASURED gap. With nothing comparable this
        // run measured none, so the evidence above is history, not a finding —
        // and the field would have read UNVERIFIABLE without the declaration.
        log.warn(
          `${CONT}UNTESTED ON THIS RUN: zero comparable pair(s), so nothing ` +
            `here exercised the declaration. The evidence above is a prior ` +
            `measurement, not this run's. Do not read it as confirmation.`,
        );
      }
    }
    // WHICH SIDE was empty — MONEY-1250. Printed whenever there is anything to
    // split, because `incomparable N` on its own is the one number in this
    // report that cannot be acted on: it is a coverage GAP and a coverage WIN
    // added together, and the two call for opposite responses.
    const blanks = blanksByField.get(field);
    if (blanks && v.incomparable > 0) {
      const sa = oursBlankStandalone.get(field) ?? 0;
      log.info(
        `${CONT}of the ${v.incomparable} incomparable: ours blank ` +
          `${blanks.oursBlank} (WE have no value — a coverage GAP), theirs ` +
          `blank ${blanks.theirsBlank} (a coverage WIN), both blank ` +
          `${blanks.bothBlank}` +
          (blanks.comparable > 0
            ? `, MIS-FILED ${blanks.comparable} (a pair with both sides ` +
              `populated reached the incomparable bucket — that is a caller ` +
              `bug, not data)`
            : ``),
      );
      if (blanks.oursBlank > 0) {
        log.info(
          `${CONT}the ours-blank ${blanks.oursBlank} do NOT move any rate ` +
            `above and do NOT block — they are the ground XBRL does not cover ` +
            `where the vendor does. ${sa} of them have a STANDALONE winner, ` +
            `and none of those is a basis mismatch either: our side is EMPTY, ` +
            `not on the wrong basis. See the OURS-BLANK block below.`,
        );
      }
    }
    if (unverifiable) {
      log.info(
        CONT +
          `UNVERIFIABLE, not agreed: the incumbent has NO value for this ` +
          `column in any of the ${v.compared} graded pair(s) — VERIFIED by ` +
          `counting incumbent values, not inferred from the incomparable ` +
          `count, which cannot say WHICH side was empty. So there is nothing ` +
          `to compare against and equally nothing for the write to destroy, ` +
          `which is the only reason this does not block. Do NOT read it as ` +
          `evidence the column is correct; it is evidence the column is new.`,
      );
    }
    if (t.translated > 0 || t.unavailable > 0) {
      // BOTH RATES, and which one the verdict used — MONEY-1239.
      //
      // Whether a definitional match should count toward readiness is a
      // judgement about how much definitional risk to carry through a one-way
      // door, and that is the founder's call, not this script's. So the
      // counterfactual is computed with the SAME judge and the SAME defaults —
      // no overrides, here or above — and labelled. `allReady` reads the
      // translated verdict only; the strict one is evidence, never a gate.
      const strict = judgeSwitchoverReadiness(byFieldStrict.get(field) ?? []);
      const strictRate =
        strict.comparable > 0
          ? (strict.disagreements / strict.comparable) * 100
          : 0;
      log.info(
        `${CONT}TRANSLATED ${t.translated} pair(s) matched only under the ` +
          `vendor's declared definition` +
          (OTHER_INCOME_TRANSLATED.has(field)
            ? ` (theirs = ours + otherIncome)`
            : ``) +
          `. These are NOT raw matches and are not folded into the ${matchedRaw} above.`,
      );
      log.info(
        `${CONT}disagreement rate WITH translations counted as matches: ` +
          `${rate.toFixed(1)}% (${v.disagreements}/${v.comparable}) — ` +
          `THIS IS THE RATE THE VERDICT ABOVE USED.`,
      );
      log.info(
        `${CONT}disagreement rate WITHOUT them (each translation demoted to a ` +
          `disagreement): ${strictRate.toFixed(1)}% ` +
          `(${strict.disagreements}/${strict.comparable}), which would read ` +
          `${strict.ready ? "READY" : "BLOCKED"}. Reported, NOT applied — ` +
          `whether a definitional match counts toward arming is the founder's ` +
          `threshold decision, and this script does not make it.`,
      );
      if (t.unavailable > 0) {
        log.info(
          `${CONT}${t.unavailable} pair(s) COULD NOT BE TESTED: the filing ` +
            `discloses no \`otherIncome\`, so the declared translation was ` +
            `unavailable rather than unsuccessful. They stay in the ` +
            `${v.disagreements} disagreement(s) above — absence of evidence is ` +
            `not a match — and are named here so the two are never confused.`,
        );
      }
    }
    const e = excludedByField.get(field);
    if (e) {
      const wouldBe = v.comparable + e.comparable;
      const share = wouldBe > 0 ? e.comparable / wouldBe : 0;
      // THE DRAIN CAP — MONEY-1237 item 7. `judgeSwitchoverReadiness`'s floor of
      // 20 comparable pairs predates the exclusions, so a field could read READY
      // on 20 survivors out of thousands — a verdict about a remnant wearing the
      // population's name. When exclusions removed HALF or more of a field's
      // comparable pairs, READY is withdrawn: not because the survivors disagree,
      // but because they no longer speak for the population the switchover will
      // write. This is EXCLUSION-DRAINED, distinct from BLOCKED-on-data, and the
      // remedy is understanding the excluded mass — not shrinking it further.
      // `outcome.verdict === "READY"`, not `v.ready` — MONEY-1255. A DECLARED
      // field is not graded at all, so there is no READY here to withdraw and
      // no verdict for the drain to speak about; setting `allReady = false` for
      // one would block the switchover on a field this run deliberately makes
      // no claim about. The drain remains fully live for every graded field.
      if (outcome.verdict === "READY" && share >= EXCLUSION_DRAIN_FLOOR) {
        allReady = false;
        log.info(
          `${CONT}EXCLUSION-DRAINED: ${(share * 100).toFixed(1)}% of this field's ` +
            `comparable pairs were excluded (floor ${EXCLUSION_DRAIN_FLOOR * 100}%). ` +
            `READY is withdrawn — the survivors no longer represent what arming ` +
            `will write.`,
        );
      }
      // Over the EXCLUDED comparable pairs, on the same basis as `rate` above,
      // so the two are directly comparable. This is the number that says whether
      // the exclusion removed a different population or just a smaller one.
      // PERCENT, matching `rate` — MONEY-1249.
      //
      // This was a FRACTION while `rate` is a percentage (`… * 100`, line ~1722),
      // and the two are compared below. `0.143 <= 8.0` is true for any excluded
      // rate under 100% against any graded rate over 1%, so the guard could not
      // fail and the sentence it gates printed on EVERY field — including the
      // three where the excluded rows disagree substantially MORE.
      //
      // Measured on prod 2026-08-22: netIncome 14.3% vs 8.0%, totalAssets 23.3%
      // vs 13.4%, totalEquity 13.3% vs 6.2%. On all three the basis hypothesis
      // is SUPPORTED and the gate reported it refuted — in the line a founder
      // reads immediately before arming a one-way door.
      const excludedRate =
        e.comparable > 0 ? (e.disagree / e.comparable) * 100 : 0;
      log.info(
        `${CONT}excluded ${e.comparable} comparable of ${wouldBe} ` +
          `(${(share * 100).toFixed(1)}%) — ` +
          [...e.byReason.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${k} ${n}`)
            .join(", ") +
          `; among them scale ${e.scale}, sign ${e.sign}, disagree ${e.disagree} ` +
          `(${excludedRate.toFixed(1)}% vs ${rate.toFixed(1)}% among survivors)`,
      );
      // The DECISION comes from `judgeExclusionComparison` — MONEY-1249. It used
      // to be an inline `excludedRate <= rate` comparing a fraction against a
      // percentage, which could not fail. Both sides are percentages now and the
      // judge is unit-tested with an excluded rate ABOVE the graded one.
      const exclusionVerdict = judgeExclusionComparison({
        excludedComparable: e.comparable,
        excludedDisagree: e.disagree,
        gradedRatePct: rate,
      });
      if (exclusionVerdict.verdict === "BASIS_HYPOTHESIS_HOLDS") {
        log.info(
          `${CONT}the excluded rows disagree MORE than the graded ones ` +
            `(${excludedRate.toFixed(1)}% vs ${rate.toFixed(1)}%), which is what ` +
            `the basis-mismatch explanation PREDICTS. The exclusion is removing a ` +
            `genuinely different population, not just shrinking the sample.`,
        );
      }
      if (exclusionVerdict.verdict === "BASIS_HYPOTHESIS_REFUTED") {
        // The BASIS HYPOTHESIS, stated so the output can refute it.
        //
        // The reason for excluding standalone-vs-vendor pairs is that they
        // measure a BASIS gap, not a data-quality one — a holding company's
        // standalone revenue differs from its consolidated by a MULTIPLE. If
        // that were true, the excluded rows would disagree MORE than the
        // survivors, and removing them would drop the rate materially.
        //
        // When they disagree no more than the survivors, the hypothesis is
        // WRONG for this field: the disagreements are real magnitude
        // differences that follow the writes we are about to make, and the
        // exclusion has bought a smaller sample rather than a cleaner one.
        // That changes what arming means, so it is said out loud rather than
        // left to be inferred from a rate that failed to move.
        log.info(
          `${CONT}the excluded rows disagree NO MORE than the graded ones ` +
            `(${excludedRate.toFixed(1)}% vs ${rate.toFixed(1)}%), so the ` +
            `basis-mismatch explanation does NOT hold for this field. These are ` +
            `real magnitude differences and they follow the rows we will write.`,
        );
      }
      if (share >= EXCLUDED_SHARE_NOTE) {
        log.info(
          `${CONT}NOTE: ${(share * 100).toFixed(1)}% of this field's comparable ` +
            `pairs were removed. "${v.ready ? "READY" : "BLOCKED"}" is a ` +
            `statement about the ${v.comparable} pair(s) the writer would ` +
            `actually write, NOT about the ${wouldBe} the vendor overlap holds.`,
        );
      }
      if (v.ready && (e.scale > 0 || e.sign > 0)) {
        // The precise failure this ticket must not introduce: a field reading
        // READY because its blockers were excluded, with a clean `scale 0` on
        // the line above and nothing saying why.
        log.info(
          `${CONT}READY RESTS ON THE EXCLUSION: ${e.scale} scale and ${e.sign} ` +
            `sign mismatch(es) left this field's ladder that way. The ladder ` +
            `blocks on ANY survivor, so the zero above means every one of them ` +
            `was excluded — not that none was found.`,
        );
      }
    }
    log.info(`${CONT}— ${v.reason}`);
  }

  // ── OURS-BLANK: the half of INCOMPARABLE that is a coverage GAP ──────
  //
  // MONEY-1250. Distinct from INCUMBENT-NULLING below, and the difference is
  // the whole reason both blocks exist. INCUMBENT-NULLING counts pairs where
  // the writer WOULD write and our absence therefore DESTROYS the vendor's
  // number. This counts the larger population where the projection produced no
  // statement at all, so nothing is written, nothing is destroyed — and the
  // vendor keeps a value we simply cannot match. That is not a loss; it is the
  // measured size of what the switchover does NOT cover, and it was previously
  // reported nowhere.
  //
  // Both are invisible to the ladder for the same reason (INCOMPARABLE is
  // outside the rate by design), so neither can be left to a reader to infer
  // from a denominator.
  const oursBlankRows = graded.filter(
    (c) => c.verdict === "INCOMPARABLE" && isOursBlank(c),
  );
  if (oursBlankRows.length > 0) {
    const periods = new Map<string, string>();
    for (const c of oursBlankRows)
      periods.set(`${c.symbol}\u0000${c.period}`, c.basis);
    const byPeriodLabel = new Map<string, number>();
    for (const c of oursBlankRows)
      byPeriodLabel.set(c.period, (byPeriodLabel.get(c.period) ?? 0) + 1);
    const standalonePeriods = [...periods.values()].filter(
      (b) => b !== "CONSOLIDATED",
    ).length;
    log.info("");
    log.info(
      `OURS-BLANK: ${oursBlankRows.length} graded (symbol, period, field) ` +
        `pair(s) across ${periods.size} period(s) where the VENDOR has a value ` +
        `and we do not. No rate above reflects them — every one scores ` +
        `INCOMPARABLE — and they are NOT a disagreement: they are the ground ` +
        `arming does not take.`,
    );
    log.info(
      `  by period: ` +
        [...byPeriodLabel.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([p, n]) => `${p} ${n}`)
          .join(", ") +
        (byPeriodLabel.size > 8 ? `, +${byPeriodLabel.size - 8} more` : ``),
    );
    log.info(
      `  ${standalonePeriods} of ${periods.size} period(s) have a STANDALONE ` +
        `winner — but NONE of these is a basis mismatch, and that is the point ` +
        `of listing them here. A basis mismatch needs TWO values on different ` +
        `bases; every pair in this block has NO value on our side. Where a ` +
        `standalone winner does produce a statement over a vendor row, ` +
        `STANDALONE_NO_DISPLACE excludes it and it is counted in the exclusion ` +
        `lines above, never here. So what this block holds is filings we hold ` +
        `and could not project — not filings on the wrong basis.`,
    );
    // The FY2025 consolidated question, settled with evidence rather than left
    // as a suspicion. Measured against NSE's own integrated-filing index on
    // 2026-08-24 over 01-04-2025 -> 31-08-2025: of the 429 symbols where we
    // hold a STANDALONE FY2025 annual filing and no CONSOLIDATED one, 419
    // appear in the index and 403 of those have NO consolidated record AT NSE.
    // A single-entity company files nothing to consolidate, so for 96% of that
    // population the standalone filing IS the complete filing.
    log.info(
      `  Note on the missing-consolidated theory: NSE publishes NO ` +
        `consolidated annual filing for the large majority of standalone-only ` +
        `symbols (403 of 419 measured for FY2025 on 2026-08-24), because a ` +
        `single-entity company has nothing to consolidate. Standalone-only is ` +
        `the CORRECT state for them, not a coverage hole to go and fill.`,
    );
  }

  // ── INCUMBENT-NULLING: the trade the ladder structurally cannot see ──
  //
  // MONEY-1239. `projectedValues` writes `null` for every OWNED field the
  // projection could not fill, so an UPDATE whose `operatingIncome` is absent
  // REPLACES the vendor's populated number with an empty cell. The ladder above
  // scores that pair INCOMPARABLE — one side has no value — and INCOMPARABLE is
  // deliberately outside the rate's denominator (MONEY-1196), so no field's
  // percentage moves and nothing BLOCKS. The gate is working as designed and
  // the loss is invisible to it.
  //
  // The population is not hypothetical. `operatingIncome` requires
  // `operatingProfitBeforeProvisions` for a lender, present in 76 of 741
  // banking and 0 of 206 NBFC ANNUAL filings on prod — ~90% of banks and 100%
  // of NBFCs project no operating income at all. `StockRatios.operatingMargin`
  // reads this column (`pct(inc?.operatingIncome, inc?.revenue)`), so those
  // symbols lose the margin along with the figure.
  //
  // Printed UNCONDITIONALLY, including the zero. "No line" and "0 pairs" have to
  // be different states, which is the same lesson the scoped-sibling lines above
  // record: a diagnostic that only appears when it is bad is absent from exactly
  // the clean run someone uses to decide READY.
  const nulling = graded.filter((c) => c.nullsIncumbent === true);
  log.info("");
  log.info(
    `INCUMBENT-NULLING: ${nulling.length} (symbol, period, field) pair(s) where ` +
      `arming would REPLACE a populated incumbent value with NULL — our side has ` +
      `no value, theirs does, and the write touches that column anyway. ` +
      `MONEY-1239 took this from 34 to 0 by making OWNERSHIP family-aware: a ` +
      `lender does not own \`operatingIncome\` or \`ebitda\`, so the write no ` +
      `longer mentions them and the vendor's value is untouched. A non-zero ` +
      `count here is therefore a NEW class, not the old one.`,
  );
  if (nulling.length > 0) {
    const nullingByField = new Map<
      Field,
      { pairs: number; symbols: Set<string> }
    >();
    for (const c of nulling) {
      const n = nullingByField.get(c.field) ?? { pairs: 0, symbols: new Set() };
      n.pairs++;
      n.symbols.add(c.symbol);
      nullingByField.set(c.field, n);
    }
    for (const [f, n] of [...nullingByField.entries()].sort(
      (a, b) => b[1].pairs - a[1].pairs,
    )) {
      log.info(
        `  ${f.padEnd(17)} ${n.pairs} pair(s) across ${n.symbols.size} symbol(s)`,
      );
    }
    log.warn(
      `  This does NOT block and cannot: every one of these scores INCOMPARABLE, ` +
        `which is outside the disagreement rate by design. It is a TRADE, not a ` +
        `defect — a period we cannot project displacing a period the vendor could ` +
        `— and it has to be accepted before arming rather than discovered after, ` +
        `because the displaced value is gone (\`StockFinancials\` has no \`source\` ` +
        `in its unique key). Lenders dominate it: \`operatingIncome\` needs ` +
        `\`operatingProfitBeforeProvisions\`, which ~90% of banking and 100% of NBFC ` +
        `ANNUAL filings do not carry, and \`StockRatios.operatingMargin\` derives ` +
        `from that column.`,
    );
    for (const c of nulling.slice(0, VERBOSE ? 200 : 10)) {
      log.info(
        `    ${c.symbol.padEnd(14)} ${c.period.padEnd(10)} ${c.field.padEnd(17)} ` +
          `ours=(absent) theirs=${c.theirs}`,
      );
    }
    if (!VERBOSE && nulling.length > 10) {
      log.info(`    … ${nulling.length - 10} more; re-run with --verbose`);
    }
  }

  // ── Is the SURVIVING scale problem systematic or a per-filing tail? ──
  //
  // MONEY-1234 wrote this block; MONEY-1235 repointed it at `graded`, so it now
  // describes the mismatches the detector MISSED rather than every mismatch
  // found. That is the actionable set: the caught ones are quarantined and will
  // not be written, while these are still on the ladder and still blocking.
  //
  // The ladder blocks on ANY scale mismatch, and for a UNITS BUG that is right:
  // one occurrence means a whole class of periods is wrong. But that rule
  // assumes the cause is ours and uniform. A filer that MIS-DECLARES its own
  // rounding produces the same verdict from a completely different cause, and
  // the two need opposite responses — fix our arithmetic, versus accept a
  // data-quality tail we cannot fix from here.
  //
  // The signature separates them. A units bug in our code is ONE factor, ONE
  // direction, spread across many symbols. A mis-declaration is a handful of
  // filings, each internally consistent across all its fields, with varied
  // factors and both directions.
  //
  // Measured on prod 2026-08-21: SILGO FY2021 declares "Thousands" while its
  // values are already absolute (all four fields 1000x high); PURVA FY2023,
  // JINDALSAW FY2021, UBL FY2022 and TRENT FY2022 declare "Lakhs" while
  // reporting in crores (100x low). `roundingLabel` is the filer's own claim,
  // and 16 of 18,381 filings claim "Thousands" at all.
  //
  // This prints the shape so the reader can tell which they are looking at
  // instead of inferring it from a count.
  const scaled = graded.filter((c) => c.verdict === "SCALE_MISMATCH");
  if (scaled.length > 0) {
    const byFactor = new Map<number, number>();
    const bySymbolPeriod = new Map<string, Set<Field>>();
    for (const c of scaled) {
      if (c.scaleFactor !== undefined) {
        byFactor.set(c.scaleFactor, (byFactor.get(c.scaleFactor) ?? 0) + 1);
      }
      const k = `${c.symbol} ${c.period}`;
      const set = bySymbolPeriod.get(k) ?? new Set<Field>();
      set.add(c.field);
      bySymbolPeriod.set(k, set);
    }
    const factors = [...byFactor.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = factors[0];
    // Denominator is `graded`, matching the population these survived in.
    const systematic =
      factors.length === 1 && bySymbolPeriod.size > graded.length / 100;
    log.info("");
    log.info(
      `scale mismatches SURVIVING the quarantine: ${scaled.length} across ` +
        `${bySymbolPeriod.size} (symbol, period) filing(s) — factors ` +
        factors.map(([f, n]) => `${f}x:${n}`).join(", "),
    );
    log.info(
      systematic
        ? `  SYSTEMATIC — one factor (${dominant?.[0]}x) over many filings. ` +
            `That is a units bug on our side; fix the conversion, do not ` +
            `exclude the rows.`
        : `  PER-FILING — ${factors.length} different factors over ` +
            `${bySymbolPeriod.size} filing(s), each internally consistent across ` +
            `its own fields. That is the signature of filers mis-declaring their ` +
            `own \`roundingLabel\`, not of our arithmetic. The detector did not ` +
            `reach these — see the recall block above for why, per filing — so ` +
            `they remain on the ladder and the ladder still says any occurrence ` +
            `blocks.`,
    );
  }

  // The examples are the actionable half. A rate tells you there is a problem;
  // a concrete (symbol, period, ours, theirs) triple is what someone can go and
  // look at. Scale and sign first because they block outright.
  //
  // GRADED only. An excluded row is not something to go and look at — the
  // writer will not write it — and letting 29.5% of the population compete for
  // 25 example slots would bury every row that still needs a human.
  const worst = graded
    .filter(
      (c) =>
        c.verdict === "SCALE_MISMATCH" ||
        c.verdict === "SIGN_MISMATCH" ||
        c.verdict === "DISAGREEMENT",
    )
    .sort((a, b) => {
      const rank = (v: ReconcileVerdict) =>
        v === "SCALE_MISMATCH" ? 0 : v === "SIGN_MISMATCH" ? 1 : 2;
      return rank(a.verdict) - rank(b.verdict);
    });

  if (worst.length > 0) {
    log.info("");
    log.info(
      `examples (${Math.min(worst.length, VERBOSE ? 200 : 25)} of ${worst.length}):`,
    );
    for (const c of worst.slice(0, VERBOSE ? 200 : 25)) {
      log.info(
        `  ${c.verdict.padEnd(15)} ${c.symbol} ${c.period} ${c.field}: ` +
          `ours=${c.ours} theirs=${c.theirs}` +
          `${c.scaleFactor ? ` (factor ${c.scaleFactor})` : ""}`,
      );
    }
    if (!VERBOSE && worst.length > 25) {
      // Never truncate silently — a capped list that does not say it is capped
      // reads as the complete set.
      log.info(`  … ${worst.length - 25} more; re-run with --verbose`);
    }
  }

  // A separate, short list for the quarantine, because an excluded row that is
  // never shown is an assertion the reader cannot check.
  const quarantineExamples = excludedRows.filter(
    (c) => c.excluded === "QUARANTINED" && c.verdict !== "INCOMPARABLE",
  );
  if (quarantineExamples.length > 0) {
    log.info("");
    log.info(
      `quarantined examples (${Math.min(quarantineExamples.length, VERBOSE ? 100 : 10)} ` +
        `of ${quarantineExamples.length}) — excluded, NOT graded:`,
    );
    for (const c of quarantineExamples.slice(0, VERBOSE ? 100 : 10)) {
      const j = scaleJudgements.get(c.filingId);
      log.info(
        `  ${c.verdict.padEnd(15)} ${c.symbol} ${c.period} ${c.field}: ` +
          `ours=${c.ours} theirs=${c.theirs}` +
          (j && j.verdict === "SCALE_SUSPECT"
            ? ` (detector: x${j.factor} on ${j.fields.join("+")}, ` +
              `${j.siblingPeriods} sibling period(s))`
            : ""),
      );
    }
    if (!VERBOSE && quarantineExamples.length > 10) {
      log.info(
        `  … ${quarantineExamples.length - 10} more; re-run with --verbose`,
      );
    }
  }

  // CONTAMINATION FAILS THE RUN — MONEY-1237.
  //
  // The `xbrlIncumbents` count above was a bare `log.warn`, and `allReady` is
  // computed only from the per-field verdicts — so a contaminated run printed
  // "VERDICT: every field is READY" and exited 0, with the warning scrolled
  // off the top. That warning even told the reader to "subtract them before
  // believing a READY", delegating the arithmetic of a ONE-WAY DOOR to whoever
  // happened to be reading log output.
  //
  // A fully contaminated run is not a rare shape — it is exactly what re-running
  // this gate AFTER arming produces, which is the natural "confirm it worked"
  // move. Every incumbent is then ours, every comparison is XBRL against
  // itself, every field matches 100%, and the gate certifies the switchover on
  // a tautology.
  //
  // Failing here is not the unpassable-ladder mistake the ratios gate had to be
  // rescued from: the remedy is obvious and available (re-run where the
  // projection was never armed). And once an environment IS armed, this gate
  // being permanently unpassable there is correct — the vendor rows it needs no
  // longer exist.
  const contaminated = xbrlIncumbents > 0;
  if (contaminated) allReady = false;
  // Same lesson, one section up, same function: a tripwire that only WARNS is
  // inert. A diverged standalone mirror means the ladder graded the wrong
  // population, and that must not read READY however clean it looks.
  if (standaloneMirrorDiverged) allReady = false;

  log.info("");
  if (contaminated) {
    log.warn(
      `VERDICT: NOT ready — ${xbrlIncumbents} incumbent row(s) are already ` +
        `${XBRL_SOURCE}, so this run compared XBRL against itself and its ` +
        `match rates mean nothing. This is not a data problem; it is the wrong ` +
        `environment. Re-run where the projection has never been armed.`,
    );
  }
  // Carried into the VERDICT line itself — MONEY-1239. The lesson the
  // contamination block above records is that a `log.warn` hundreds of lines
  // earlier is inert: the reader sees the verdict. This does not change the
  // verdict (it is a trade, not a failure) but it must travel with it.
  const nullingNote =
    nulling.length > 0
      ? ` ARMING ALSO NULLS ${nulling.length} populated incumbent value(s) — ` +
        `see the INCUMBENT-NULLING block above; those pairs are INCOMPARABLE and ` +
        `no rate above reflects them.`
      : ``;
  // CARRIED INTO THE VERDICT LINE — MONEY-1255, same lesson as `nullingNote`
  // above and as the contamination block before it: a disclosure hundreds of
  // lines earlier is inert, because the reader reads the verdict. Neither of
  // these changes the verdict; both change what the verdict MEANS, so both have
  // to travel with it.
  //
  // The symbol note is the sharper of the two. It is the only qualifier here
  // that describes rows the writer WILL write — a READY that says nothing about
  // it would be read as "the population is clean" when what it means is "the
  // population is clean once the four symbols we already know are wrong are
  // taken out".
  const symbolNote =
    symbolExcludedRows.length > 0
      ? ` ${symbolExcludedRows.length} comparison(s) across ` +
        `${symbolTallies.filter((t) => t.total > 0).length} of ` +
        `${symbolTallies.length} DECLARED-OUT SYMBOL(S) ` +
        `(${symbolTallies.map((t) => t.symbol).join(", ")}) were removed from ` +
        `the ladder, and unlike every other exclusion here THE WRITER STILL ` +
        `WRITES THEM — see the SYMBOL EXCLUSIONS block above.`
      : ` No symbol exclusions removed anything: all ` +
        `${symbolTallies.length} declared symbol(s) ` +
        `(${symbolTallies.map((t) => t.symbol).join(", ")}) removed ZERO ` +
        `comparisons, so the list is currently buying nothing here.`;
  const declaredFields = FIELDS.filter(
    (f) => DECLARED_FIELD_DIVERGENCES[f] !== undefined,
  );
  const declaredNote =
    declaredFields.length > 0
      ? ` ${declaredFields.length} field(s) are NOT GRADED by declared ` +
        `definitional divergence (${declaredFields.join(", ")}) — our figure ` +
        `and the incumbent's are not the same quantity, so this run neither ` +
        `verified nor faulted them. That is a DELIBERATE non-claim, not an ` +
        `agreement.`
      : ``;
  log.info(
    allReady
      ? `VERDICT: every field is READY over the ${graded.length} GRADED ` +
          `comparison(s). Read that as evidenced FOR WHAT THE WRITER WILL WRITE: ` +
          `${excludedRows.length} comparison(s) were excluded (${quarantinedComparisons} ` +
          `quarantined, ` +
          `${excludedRows.length - quarantinedComparisons - symbolExcludedRows.length} ` +
          `because the incumbent survives, ${symbolExcludedRows.length} because the ` +
          `SYMBOL was declared out). The first two categories do not change when ` +
          `the switchover is armed. THE THIRD DOES — those rows get written. ` +
          `The per-field lines above name every exclusion.` +
          nullingNote +
          symbolNote +
          declaredNote
      : `VERDICT: NOT ready over the ${graded.length} GRADED comparison(s). ` +
          `Resolve the blocked fields above before pointing any reader at XBRL. ` +
          `Surviving scale and sign errors are systematic; fix them, do not ` +
          `average them away — and do not widen the quarantine to swallow them, ` +
          `which is the same move wearing a new name.` +
          nullingNote +
          symbolNote +
          declaredNote,
  );
  if (!allReady) process.exitCode = 1;

  await prisma.$disconnect();
}

/* ── entry point ────────────────────────────────────────────────────────── */

/**
 * `main()` runs ONLY when this file is what was executed — MONEY-1287.
 *
 * `packages/core/__tests__/market-data/reconcile-symbol-paging.test.ts` imports
 * `readFilingsBySymbolPage` from here to drive it against a counted fake. An
 * unguarded `main()` at module scope would open a database connection the
 * moment that test imported the file, and on a machine with no `DATABASE_URL`
 * the `.catch` below would `process.exit(1)` and take the whole test process
 * with it.
 *
 * Same guard, same reasoning and the same two lines as
 * `scripts/data/edgar-coverage-report.ts` — deliberately not a bespoke env
 * flag. The failure direction matters: `process.argv[1]` is undefined only when
 * there is no script entry at all, and any direct `npx tsx …` invocation
 * matches, so the gate cannot be silently disarmed by a missing variable. That
 * is the MF_METADATA_PROVIDER shape (MONEY-1214) this repo has paid for twice.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error("[xbrl-reconcile] FAILED", err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
