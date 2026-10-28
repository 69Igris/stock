/**
 * The StockRatios switchover gate's JUDGEMENT — MONEY-1235.
 *
 * Sibling of `judgeSwitchoverReadiness` (the StockFinancials reconcile's
 * judgement, in `xbrl-projection.ts`): pure, unit-tested, and deliberately
 * separate from the script that feeds it, so the ladder can be reasoned about
 * without a database in the room.
 *
 * ## Why this exists as its own module
 *
 * The ladder used to live inline in `scripts/data/xbrl-ratios-validate.ts`, and
 * it could never pass. It BLOCKED whenever the comparison was thin — including
 * the case where the thinness is entirely on the VENDOR's side, which the same
 * function printed as:
 *
 *     "Not evidence about our derivation, in either direction."
 *
 * and then counted as a failure anyway. Measured on prod 2026-08-21, four of
 * the five ratios have essentially no vendor coverage:
 *
 *     operatingMargin      0 of 2,135   (0.0%)
 *     netMargin           86 of 2,135   (4.0%)
 *     roa                 85 of 2,135   (4.0%)
 *     debtToEquity        86 of 2,135   (4.0%)
 *     roe              2,038 of 2,135  (95.5%)
 *
 * So `pass` was unreachable, which made the arming precondition "the ratios
 * gate reads READY" unsatisfiable by construction. Blocking on that is backwards
 * twice over: it gates OUR derivation on a vendor we are RETIRING precisely
 * because its data is unavailable, and it reports "not ready" when the only
 * honest statement is "not checkable here".
 *
 * ## Four verdicts, because there are four situations
 *
 * `UNVERIFIABLE` is not a softer `BLOCKED`. It says the vendor side is empty, so
 * this run learned nothing about the ratio — it neither passes nor blocks, and
 * it is named in the summary so the absence stays visible instead of being
 * rounded into "ready".
 *
 * The distinction that matters most is between the two THIN cases:
 *
 *   - thin because THEY lack the data      -> UNVERIFIABLE (not our problem)
 *   - thin because WE cannot derive it     -> BLOCKED      (very much our problem)
 *
 * Collapsing those two is what made the old ladder useless.
 *
 * `DECLARED_DIVERGENCE` (MONEY-1250) is the fourth, and it is about neither
 * volume nor accuracy: the two columns are not the same QUANTITY, and the source
 * documents cannot make them so. It is deliberately not spelled `UNVERIFIABLE`,
 * because those two ask for opposite next steps — "get more vendor rows" versus
 * "no number of vendor rows would help". It never counts as verification, so a
 * run of nothing-but-declarations still fails the all-unverifiable check.
 *
 * ## The all-unverifiable trap
 *
 * A run where nothing BLOCKS and nothing is READY has proved exactly nothing.
 * Reporting that as success would be the MONEY-1220 failure mode in gate form:
 * a green verdict describing a comparison that never happened. `judgeRatiosGate`
 * fails it explicitly.
 *
 * ## The self-comparison trap — MONEY-1237
 *
 * The gate's whole premise is that the incumbent is a VENDOR value about to be
 * destroyed. `StockRatios` has no `source` in its unique key, so the first XBRL
 * write for a symbol overwrites whatever was there; once that has happened, the
 * "incumbent" IS our own projection, and comparing against it is XBRL against
 * XBRL — a tautological MATCH that can only inflate a rate, never lower it.
 *
 * This is not hypothetical. The ratios job's write arm is `XBRL_RATIOS_APPLY`
 * (MONEY-1286 split it out of `XBRL_PROJECTION_APPLY`, which now arms only the
 * StockFinancials projection — the two gates disagreed on prod 2026-08-30, and
 * one flag could not express "ratios yes, financials no"). So:
 *
 *   - anyone who flips it in QA to try it out, or
 *   - anyone who re-runs the gate on prod AFTER arming — which is the natural
 *     "confirm it worked" move —
 *
 * gets incumbents already stamped `NSE_XBRL`. The split narrows the blast radius
 * but does not remove this trap: `XBRL_RATIOS_APPLY=true` contaminates THIS
 * table exactly as the shared flag did. On the measured prod population
 * (2026-08-21) `roe` is the ONLY ratio with real vendor coverage — 2,038 of
 * 2,135 rows against 0 / 86 / 85 / 86 for operatingMargin / netMargin / roa /
 * debtToEquity — so once `roe` is contaminated it matches ITSELF, reads READY,
 * and {@link judgeRatiosGate} passes the whole run on one READY plus four
 * UNVERIFIABLE. The switchover would then be "evidenced" by XBRL against XBRL.
 *
 * ### What this module DOES about it, and why not the alternatives
 *
 * Self-comparisons are **excluded from the judged population — numerator AND
 * denominator — and the run FAILS while any are present.** Both halves are
 * needed and neither is sufficient:
 *
 *   - Excluding from the numerator only would drain the denominator, which is
 *     the MONEY-1196 defect this file already carries scars from. Removing a
 *     pair from both sides is the only arithmetic under which the surviving rate
 *     still means "share of INDEPENDENT pairs that agreed".
 *
 *   - Excluding alone is not enough either, because the exclusion can drain the
 *     population below {@link RATIO_MIN_COMPARABLE}, at which point the old
 *     ladder would have BLOCKED and blamed OUR derivation ("WE cannot derive
 *     what they could") for what is actually an environment that has already
 *     been armed. That mis-attribution is exactly the shape
 *     {@link RATIO_VENDOR_FLOOR} exists to prevent, so the drained case gets its
 *     own rung and its own message.
 *
 *   - Reporting-only — the choice `scripts/data/xbrl-reconcile.ts` made for the
 *     financials half — is not enough here, and the divergence is deliberate.
 *     That guard is a bare `log.warn`: its `xbrlIncumbents` count never reaches
 *     `allReady`, so a fully contaminated reconcile run still prints "VERDICT:
 *     every field is READY" and exits 0. A warning that cannot change the
 *     verdict is a warning the next reader scrolls past, and this is a one-way
 *     door — `StockRatios` keeps no `source` history, so the vendor value the
 *     gate needed is gone the moment the job writes.
 *
 * ### Why FAILING is not the old unpassable-ladder mistake
 *
 * The ladder MONEY-1235 replaced was unsatisfiable BY CONSTRUCTION: no action an
 * operator could take would make it pass. This one fails on a condition with an
 * obvious remedy — re-run the gate in an environment where the projection has
 * not been armed. And once an environment IS armed, the gate becoming permanently
 * unpassable there is the CORRECT semantics, not a bug: the vendor rows it
 * needed no longer exist, so that environment can never again produce arming
 * evidence.
 *
 * Scale and sign mismatches are the one thing NOT discounted, even when seen on
 * a self-comparison. A power-of-ten disagreement between our own writer and our
 * own projection is a real finding, and discounting a BLOCKER is the only
 * direction that can turn a block into a false READY.
 */

/**
 * Ratios whose FILL RATE may not regress — MONEY-1401.
 *
 * The agreement rungs below can only see rows that exist on BOTH sides. They
 * are therefore structurally blind to the one outcome that matters most on a
 * one-way door: arming the writer and finding the column EMPTY. Replacing a
 * stale-but-populated vendor column with a fresh-but-empty one of ours is a
 * regression no match rate can express — a ratio we derive for nobody scores
 * 100% on the handful of symbols we do derive it for.
 *
 * Measured on prod 2026-09-13 over the graded population, ours against theirs:
 *
 *     roe          797 vs   807     <- REGRESSION
 *     roce       1,704 vs 1,735     <- REGRESSION
 *     netMargin  1,726 vs    21
 *     roa          839 vs     14
 *     debtToEquity 1,666 vs   21
 *     operatingMargin 1,726 vs 0
 *
 * These three and not the others because they are the columns a reader
 * actually sees: `roe` and `roce` are the two the vendor genuinely covers
 * (2,038 / 2,118 of 2,135 rows), and `netMargin` is the margin the Financials
 * tab leads with. A regression on a column the vendor never filled costs a
 * reader nothing, so those WARN instead of blocking — the check still runs and
 * still prints, it just does not gate.
 */
export const FILL_BLOCKING_RATIOS: ReadonlySet<string> = new Set([
  "roe",
  "roce",
  "netMargin",
]);

/**
 * The balance sheet must BALANCE: |L + E - A| / |A| <= this.
 *
 * 0.1%. Tight on purpose — this is an ACCOUNTING IDENTITY, not a measurement,
 * so the only legitimate residual is rounding in the filed figures. A looser
 * band would admit a genuinely mis-parsed statement, which is the whole thing
 * this rung is for.
 */
export const BALANCE_IDENTITY_TOLERANCE = 0.001;

/**
 * Above this share of CHECKABLE filings failing the identity, the run BLOCKS.
 *
 * ## The ceiling was verified, and today the rung is a REGRESSION DETECTOR
 *
 * A check that has never failed is indistinguishable from a check that CANNOT
 * fail, so it was measured rather than assumed. Across all 22,807 ANNUAL
 * non-cumulative filings on prod 2026-09-13, reading the FILED
 * `totalLiabilities` against the projection's assets and equity:
 *
 *     10,185 checkable      10,114 residual EXACTLY zero
 *                               71 residual non-zero, worst 0.00026%
 *                                0 over the 0.1% tolerance
 *     12,622 UNCHECKABLE — the filing carries no `totalLiabilities` at all
 *
 * So the arithmetic is live (71 rows prove it is not a tautology) and NSE's own
 * validation means a filed balance sheet balances. What this rung catches is a
 * regression in OUR projection or a future non-XBRL source, not a bad filer —
 * and it costs one subtraction per graded symbol to keep that guarantee after
 * the vendor rungs have gone dark.
 *
 * The 55% UNCHECKABLE is a finding in its own right and is why the count is
 * reported apart rather than folded into the denominator. It collapses to 13 of
 * 1,736 on the gate's own graded population, which is the modern
 * integrated-filing era where the concept is present.
 */
export const BALANCE_IDENTITY_MAX_FAIL_RATE = 0.02;
export type BalanceIdentityVerdict = "PASS" | "FAIL" | "UNCHECKABLE";

/**
 * Does one filing's balance sheet balance? — MONEY-1401.
 *
 * ## Why this rung exists at all
 *
 * Every other rung in this module asks the vendor a question. The vendor is
 * being RETIRED — `stock_ratios` is frozen on a 2026-03-21 snapshot and
 * `financial-data-sync` is a dead job — so every one of them has a shelf life,
 * and the gate they feed is a one-way door (`StockRatios` is
 * `@@unique([symbol, exchange])` with no `source` in the key: the first XBRL
 * write destroys the evidence).
 *
 * This is the check that survives the vendor being dead. It needs no second
 * party: a statement whose assets do not equal liabilities plus equity is
 * wrong on its own terms, whoever else agrees with it.
 *
 * ## FEED IT THE FILED LIABILITIES, NEVER A DERIVED ONE
 *
 * This function cannot tell where its arguments came from, and there is one
 * argument that makes it vacuous. `projectFinancials` fills
 * `balanceSheet.totalLiabilities` as
 * `num(v,"totalLiabilities") ?? totalAssets - totalEquity`
 * (`xbrl-projection.ts:1445`). Hand it that and `|L + E - A|` is EXACTLY ZERO
 * by construction on every filing that took the fallback — the check passes
 * 100%, cannot fail, and reads as the strongest line in the report. The first
 * wiring of this rung did exactly that and scored 1,736 of 1,736.
 *
 * The caller must read the FILED concept. `xbrl-ratios-validate.ts` does, and
 * the source scan in `xbrl-ratios-self-comparison-wiring.test.ts` fails if it
 * stops.
 *
 * ## UNCHECKABLE is a THIRD value, never a pass
 *
 * A missing leg cannot be read as "balanced" — that is the permissive reading
 * of "we could not tell", and it is exactly how a parser that stopped emitting
 * `totalLiabilities` would score 100%. It is counted apart and reported apart.
 * A zero `totalAssets` is UNCHECKABLE for the same reason rather than a divide
 * by zero.
 */
export function checkBalanceIdentity(
  totalAssets: number | null | undefined,
  totalLiabilities: number | null | undefined,
  totalEquity: number | null | undefined,
): BalanceIdentityVerdict {
  const finite = (v: number | null | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const a = finite(totalAssets);
  const l = finite(totalLiabilities);
  const e = finite(totalEquity);
  if (a === undefined || l === undefined || e === undefined) {
    return "UNCHECKABLE";
  }
  if (a === 0) return "UNCHECKABLE";
  return Math.abs(l + e - a) / Math.abs(a) <= BALANCE_IDENTITY_TOLERANCE
    ? "PASS"
    : "FAIL";
}

export type RatioFillVerdict = "OK" | "WARN" | "BLOCK";

export interface RatioFill {
  /** Symbols where OUR derivation produced a finite value. */
  xbrl: number;
  /** Symbols where the INCUMBENT carried a value. */
  vendor: number;
  verdict: RatioFillVerdict;
}

/**
 * Judge one ratio's FILL RATE — MONEY-1401. See {@link FILL_BLOCKING_RATIOS}.
 *
 * Deliberately NOT a rate: the two counts are over the same population, so the
 * raw numbers are directly comparable and a reader can act on them. A
 * percentage would hide the size of the population, which is the thing that
 * decides whether a 30-row gap matters.
 *
 * ## THE POPULATION IS THE WRITER'S, NOT THE GRADER'S — F8
 *
 * These counts come from {@link RatioGateInput.fill}, NOT from
 * {@link RatioGateInput.weHave} / {@link RatioGateInput.theyHave}. They were,
 * and that made the rung answer a different question than the one it asks.
 *
 * `weHave`/`theyHave` are the AGREEMENT ladder's inputs: they count the gate's
 * GRADED population, keyed on the FILING's exchange — `"NSE"` on all 108,073
 * rows. The writer keys its upsert on the INSTRUMENT's exchange and refuses at
 * the write when the two disagree. Measured on prod 2026-09-13: of the 2,025
 * graded symbols, only **552** have an active instrument in the
 * `XBRL_ARM_WHERE` cohort at all and only **155** have their own annual winner
 * on one — so **1,870 of 2,025 (92.3%)** of the rows this rung was counting are
 * rows the writer will never write.
 *
 * Both errors were live, in opposite directions. A surplus sitting entirely in
 * the never-written 92% can mask a regression in the 8% (false PASS); and `roe`
 * at 797 vs 807, the regression this rung shipped to catch, is itself almost
 * entirely in the un-displaced cohort (false BLOCK).
 *
 * `weHave`/`theyHave` are deliberately NOT repointed at the writer's
 * population: the vendor floor asks "is there enough of THEIR data to judge OUR
 * ARITHMETIC", which is a question about the derivation and not about which
 * rows get stored. Narrowing it would drop `roa`/`netMargin`/`debtToEquity`
 * from 80/81/81 vendor rows to 3 and make them UNVERIFIABLE for a reason that
 * has nothing to do with vendor coverage.
 */
export function judgeRatioFill(
  ratio: string,
  xbrlFill: number,
  vendorFill: number,
): RatioFill {
  const n = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const xbrl = n(xbrlFill);
  const vendor = n(vendorFill);
  const verdict: RatioFillVerdict =
    xbrl >= vendor ? "OK" : FILL_BLOCKING_RATIOS.has(ratio) ? "BLOCK" : "WARN";
  return { xbrl, vendor, verdict };
}

/**
 * Which symbols can the RATIOS WRITER actually reach? — MONEY-1401 F8.
 *
 * The one line the whole writer-reachable population rests on is
 * `instrument.exchange === filing.exchange`, and it lived inline in
 * `scripts/data/xbrl-ratios-validate.ts` where no test could reach it: deleting
 * it restored the 92.3% over-count with the suite fully green. It is a POLICY —
 * which rows arming would store — so it belongs beside the rungs that judge it,
 * not in a script.
 *
 * `XbrlFiling.exchange` is `"NSE"` on all 108,073 rows, while `StockRatios` is
 * upserted against the INSTRUMENT's exchange; a symbol can hold both an NSE and
 * a BSE instrument row while its filings point at only one of them, and the
 * writer refuses when the two disagree.
 *
 * `activeInstrumentsById` carries ONLY instruments the writer's own
 * `XBRL_ARM_WHERE` cohort admits (active, on this platform) — the caller does
 * that filtering in its query, so an id missing from the map is unreachable for
 * whatever reason the caller applied, and this function does not have to know
 * which.
 */
export function writerReachableSymbols(
  filings: Iterable<{
    symbol: string;
    exchange: string;
    instrumentId: string | null;
  }>,
  activeInstrumentsById: ReadonlyMap<string, { exchange: string }>,
): Set<string> {
  const reachable = new Set<string>();
  for (const f of filings) {
    if (!f.instrumentId) continue;
    const inst = activeInstrumentsById.get(f.instrumentId);
    if (inst && inst.exchange === f.exchange) reachable.add(f.symbol);
  }
  return reachable;
}

export type WritableAgreementVerdict = "OK" | "BLOCK" | "NOT_MEASURED";

export interface WritableAgreement {
  /** Comparable pairs whose symbol is WRITER-REACHABLE. */
  comparable: number;
  /** Of {@link comparable}, how many agreed within tolerance. */
  matched: number;
  /** `matched / comparable`, or 0 when nothing was comparable. */
  matchRate: number;
  verdict: WritableAgreementVerdict;
}

/**
 * Does this ratio agree ON THE ROWS THE WRITER WOULD ACTUALLY WRITE? —
 * MONEY-1401 F8b.
 *
 * ## The hole this closes, and the one it deliberately leaves open
 *
 * {@link judgeAgreementLadder} grades the population joined on the FILING's
 * exchange; the writer keys its upsert on the INSTRUMENT's and refuses when the
 * two disagree. Measured on prod 2026-09-13, 1,870 of 2,025 graded symbols
 * (92.3%) sit on an instrument the writer cannot reach. So a ratio that AGREES
 * across the un-writable 92% and DISAGREES on the ~155 rows arming would
 * actually store reads READY, `blocked` empty, `pass` true — a FALSE READY on a
 * one-way door, which is the worst outcome this gate has.
 *
 * That direction is closed here. The OTHER direction — a ratio blocked by
 * mismatches that all sit in the un-writable cohort — is deliberately NOT
 * closed, and the review that asked for it was wrong on the merits:
 *
 *   - A scale or sign mismatch is evidence about the DERIVATION CODE, which is
 *     the same code for every symbol. `roce`'s 49 sign mismatches are a
 *     statement about how we compute `roce`, not about those 49 rows.
 *   - The writer-reachable set is an ACCIDENT of instrument resolution, not a
 *     property of the data: `scripts/data/reresolve-xbrl-instruments.ts` takes
 *     it from ~155 to ~2,000. Dropping a blocker because today's cohort happens
 *     to exclude it arms the door and then grows the cohort to include it.
 *   - Narrowing the ladder's own inputs would also collapse `theyHave` for
 *     `roa`/`netMargin`/`debtToEquity` from ~80 rows to ~3, making them
 *     UNVERIFIABLE for a reason that has nothing to do with vendor coverage —
 *     the exact mis-attribution {@link judgeRatioFill}'s header refuses.
 *
 * So this rung is STRICT-ONLY, like the fill rung it sits beside: it can turn a
 * non-blocking verdict into BLOCKED and can never rescue one.
 *
 * ## Why a thin writable cohort ABSTAINS rather than blocking
 *
 * Under the floor this compares a handful of pairs, and a rate over three rows
 * is noise in a costume — the same argument {@link RATIO_VENDOR_FLOOR} makes.
 * So the RATE is not judged. What must NOT happen is the ratio going on to read
 * READY, and that is handled by {@link judgeRatioReadiness}: a READY whose
 * writable cohort was NOT MEASURED is downgraded to UNVERIFIABLE there.
 *
 * ## THIS DOCSTRING USED TO CLAIM A PROTECTION THAT DID NOT EXIST
 *
 * It read: "the hazard of abstaining (a rung going quiet) is answered one level
 * up — {@link RatiosRunContext.fillPopulation} fails the whole RUN when the
 * writer-reachable population is below {@link FILL_MIN_POPULATION}, so 'we
 * could not measure the writable cohort' is never a passing state."
 *
 * That was a UNITS ERROR and it was load-bearing. `fillPopulation` counts
 * SYMBOLS (179 on prod 2026-09-14); `comparable` here counts COMPARABLE PAIRS
 * PER RATIO (0, 69 and 133 on that same run). Neither bounds the other, and
 * `judgeRatiosGate` never read `writable` when computing `pass` — so
 * NOT_MEASURED was byte-identical to OK at run level. Executed: a judgement
 * with `writable {comparable: 7, matched: 0}` — zero agreement on every row
 * arming would store — returned READY and the RUN passed.
 *
 * Naming a bug in a comment is not protection from it. The protection is the
 * downgrade in {@link judgeRatioReadiness} plus the run-level term in
 * {@link judgeRatiosGate}, and both are pinned by tests.
 *
 * NOT_MEASURED is a third value and is reported, never folded into OK.
 */
export function judgeWritableAgreement(
  comparable: number,
  matched: number,
  opts?: { minComparable?: number; passRate?: number },
): WritableAgreement {
  const minComparable = opts?.minComparable ?? RATIO_MIN_COMPARABLE;
  const passRate = opts?.passRate ?? RATIO_PASS_RATE;
  const n = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const c = n(comparable);
  // Clamped to the population it was drawn from: a caller bug that reports more
  // matches than pairs would otherwise print a rate above 100% and pass.
  const m = Math.min(n(matched), c);
  const matchRate = c === 0 ? 0 : m / c;
  const verdict: WritableAgreementVerdict =
    c < minComparable ? "NOT_MEASURED" : matchRate < passRate ? "BLOCK" : "OK";
  return { comparable: c, matched: m, matchRate, verdict };
}

/** Minimum pairs where BOTH sides had a value before OUR side can be judged. */
export const RATIO_MIN_COMPARABLE = 50;

/**
 * Minimum rows carrying the ratio ON THE VENDOR SIDE before the comparison is
 * evidence about us at all.
 *
 * Below this the vendor cannot disagree with us in a way that means anything —
 * and, importantly, a "scale mismatch" computed against three vendor rows is
 * noise wearing the costume of a systematic error, which is why vendor coverage
 * is checked BEFORE the systematic-error rule.
 *
 * IT IS DELIBERATELY EQUAL TO {@link RATIO_MIN_COMPARABLE}, not lower. Set
 * below it, the two thresholds open a band — 25..49 vendor rows — in which
 * READY is structurally unreachable: `comparable` can never exceed `theyHave`,
 * so such a ratio cleared the vendor floor and then failed the comparable floor,
 * BLOCKING and blaming OUR derivation for the vendor's thin coverage. One
 * BLOCKED fails the whole run, so a vendor refresh trimming
 * `netMargin`/`roa`/`debtToEquity` (86/85/86 today) into the 30s would have made
 * the ratios gate permanently unpassable, for a reason the output would have
 * mis-attributed. Equal thresholds mean every ratio is either judgeable on our
 * merits or honestly UNVERIFIABLE — MONEY-1235.
 */
export const RATIO_VENDOR_FLOOR = RATIO_MIN_COMPARABLE;

/**
 * Minimum CHECKABLE filings before the identity rung is evidence — MONEY-1401.
 *
 * The {@link RATIO_MIN_COMPARABLE} analogue this rung shipped WITHOUT, and its
 * absence made the rung's own headline failure unreachable. `identityChecked`
 * of zero produced `identityFailRate: undefined`, `identityBlocked: false`, and
 * a PASSING run — so "a parser that stopped emitting `totalLiabilities`", the
 * exact regression {@link checkBalanceIdentity}'s docstring names, scored
 * NOT-MEASURED and did not gate. A rung that goes quiet when it breaks is the
 * MONEY-1238 shape: a monitor over a series nobody produces.
 *
 * NOT MEASURED is therefore a BLOCK here, not a shrug, and that is the opposite
 * polarity to {@link RatioGateInput.declaredDivergence}'s absence. The
 * difference is which way the permissive reading points: there, "the caller did
 * not declare" means GRADE IT, the strictest outcome available; here, "nothing
 * was checkable" would mean WAVE IT THROUGH.
 *
 * 50, matching `RATIO_MIN_COMPARABLE` rather than picked separately — the two
 * express the same judgement about how small a sample stops being evidence, and
 * a second number would be a second thing to keep in agreement. It is far below
 * any healthy reading: measured on prod 2026-09-13, the vendor-graded
 * population alone checks 1,723 of 1,736, and the whole annual population
 * checks 10,185 of 22,807.
 */
export const BALANCE_IDENTITY_MIN_CHECKED = RATIO_MIN_COMPARABLE;

/**
 * Minimum WRITER-REACHABLE symbols before the fill census is evidence —
 * MONEY-1401 F8. See {@link RatiosRunContext.fillPopulation}.
 *
 * Same value and same argument as {@link BALANCE_IDENTITY_MIN_CHECKED}: below
 * this, a comparison of two counts is not a measurement, and its OK verdict is
 * "we found nothing" wearing the costume of "nothing is wrong".
 */
export const FILL_MIN_POPULATION = RATIO_MIN_COMPARABLE;

/** The spec's gate: >= 95% of comparable pairs within tolerance. */
export const RATIO_PASS_RATE = 0.95;

export type RatioGateVerdict =
  | "READY"
  | "BLOCKED"
  | "UNVERIFIABLE"
  | "DECLARED_DIVERGENCE";

export interface RatioGateInput {
  ratio: string;
  /** Pairs where BOTH sides had a value. */
  comparable: number;
  /** Of `comparable`, how many agreed within tolerance. */
  matched: number;
  scaleMismatches: number;
  signMismatches: number;
  /** Rows where WE derived a value. */
  weHave: number;
  /**
   * Rows where the INCUMBENT carried a value — whatever wrote it.
   *
   * Deliberately NOT discounted by {@link selfComparisons}, even though a
   * contaminated row is ours rather than the vendor's. Discounting it here would
   * only change which UNVERIFIABLE message is printed, because the
   * self-comparison rung fires first in every case where the two disagree, and
   * "no vendor data at all" is the wrong thing to tell an operator whose vendor
   * data was destroyed by our own write. MONEY-1237.
   */
  theyHave: number;
  /**
   * The FILL CENSUS over the population the WRITER can actually reach —
   * MONEY-1401 F8. `xbrl` is what the write PLAN would fill; `vendor` is what
   * the incumbent carries, over that same population.
   *
   * REQUIRED, like {@link selfComparisons} and for the same reason. The rung
   * this feeds is the only one that can see the outcome that matters most on a
   * one-way door — arming the writer and finding the column EMPTY — and the
   * permissive reading of "the caller did not measure it" is a gate waving that
   * through. A required field makes the production caller's omission a COMPILE
   * error rather than a silently-skipped rung.
   *
   * It is NOT `{weHave, theyHave}` under another name: those two are graded on
   * the FILING's exchange and the writer keys on the INSTRUMENT's. See
   * {@link judgeRatioFill}.
   */
  fill: { xbrl: number; vendor: number };
  /**
   * The agreement counts restricted to WRITER-REACHABLE symbols — MONEY-1401
   * F8b. See {@link judgeWritableAgreement}.
   *
   * OPTIONAL, where {@link fill} is required, and the difference is a property
   * of THIS FILE rather than of the rung: `judgeRatioReadiness` is called with
   * hand-built literals throughout `xbrl-ratios-gate.test.ts`, where the
   * writable cohort is not the subject, so a required field would make every
   * one of them state a number it has no opinion about.
   *
   * Absence therefore means "this caller did not measure it", which is reported
   * as NOT_MEASURED and never as OK. The PRODUCTION caller is pinned separately
   * — the source scan in `xbrl-ratios-writable-cohort.test.ts` fails if
   * `scripts/data/xbrl-ratios-validate.ts` stops passing it — and the RUN-level
   * {@link RatiosRunContext.fillPopulation} floor already refuses a run whose
   * writer-reachable population is too small to measure anything over.
   */
  writable?: { comparable: number; matched: number };
  /**
   * Of {@link comparable}, the pairs whose INCUMBENT was already stamped with
   * the XBRL source — XBRL compared against itself. See the self-comparison
   * trap in the header. MONEY-1237.
   *
   * REQUIRED, not optional-defaulting-to-zero. An absent field and a measured
   * zero must not be the same state — that is how `MF_METADATA_PROVIDER`
   * disabled its job silently for months (MONEY-1214) — and here the fail-open
   * reading of "the caller didn't say" is a gate certifying itself.
   */
  selfComparisons: number;
  /** Of {@link matched}, how many were those self-comparisons. */
  selfMatched: number;
  /**
   * This ratio is measuring a DIFFERENT QUANTITY than the incumbent's column,
   * by a difference the source documents cannot close — MONEY-1250.
   *
   * The string is the EVIDENCE, printed verbatim in the report. A declaration
   * with no reason is not a declaration, it is a suppression, so the field
   * carries the argument rather than a boolean.
   *
   * ## Why this is OPTIONAL where {@link selfComparisons} is REQUIRED
   *
   * The two absences point opposite ways. "The caller didn't say how many
   * self-comparisons there were" has to be treated as CONTAMINATED, because the
   * permissive reading (zero) is a licence to read READY — that is why the field
   * above is mandatory and why a NaN survives all the way to
   * {@link judgeRatiosGate}. Here the permissive reading is the opposite one:
   * absent means "no declaration", which means GRADE IT NORMALLY, which is the
   * STRICTEST outcome available. A caller who forgets to declare gets a gate
   * that judges the ratio, not one that waves it through.
   *
   * ## What it does NOT do
   *
   * It cannot rescue a ratio from a systematic error the vendor side is large
   * enough to evidence — see the rung in {@link judgeRatioReadiness}. A
   * definitional difference in what a column MEANS does not produce a
   * power-of-ten gap, so a declaration that suppressed a SCALE flag would be
   * hiding a units bug behind a paragraph of prose.
   */
  declaredDivergence?: string;
}

export interface RatioGateJudgement {
  ratio: string;
  verdict: RatioGateVerdict;
  /**
   * Share of INDEPENDENT comparable pairs that matched; 0 when nothing
   * independent is comparable.
   *
   * MONEY-1237: this is deliberately net of self-comparisons on both sides of
   * the fraction. A rate computed over the raw counts is inflated by every
   * XBRL-vs-XBRL pair, which is the number an operator reads before opening a
   * one-way door.
   */
  matchRate: number;
  /** Why this verdict, in the words an operator needs. */
  reason: string;
  /**
   * Pairs excluded as XBRL-vs-XBRL. Zero in an environment where the projection
   * has never been armed, which is every environment today. Carried on the
   * judgement so {@link judgeRatiosGate} can fail the run without the script
   * having to remember to tell it twice. MONEY-1237.
   */
  selfComparisons: number;
  /** Comparable pairs the verdict actually rests on: `comparable - selfComparisons`. */
  independentComparable: number;
  /**
   * FILL RATE — MONEY-1401. Ours against the incumbent's, over the graded
   * population for this ratio.
   *
   * OPTIONAL, and the polarity is the opposite of {@link selfComparisons}'s on
   * the INPUT side. This is an OUTPUT type: {@link judgeRatioReadiness} always
   * sets it, so the only way it is absent is a judgement assembled by hand in a
   * test, where "no fill information" is the honest reading and the summary
   * simply omits the line. The half that gates is not optional — a BLOCKING
   * fill regression is folded into {@link verdict} itself, which every caller
   * already reads, so a caller that ignores this field still fails the run.
   */
  fill?: RatioFill;
  /**
   * AGREEMENT over the WRITER-REACHABLE cohort — MONEY-1401 F8b. Absent only
   * when the caller passed no {@link RatioGateInput.writable}.
   *
   * Like {@link fill}, the half that GATES is folded into {@link verdict}, so a
   * caller that ignores this field still fails the run.
   */
  writable?: WritableAgreement;
}

export interface RatioGateThresholds {
  minComparable?: number;
  vendorFloor?: number;
  passRate?: number;
}

/**
 * The AGREEMENT ladder for one ratio — everything that asks the vendor a
 * question. {@link judgeRatioReadiness} wraps it with the fill-rate rung, which
 * asks nobody.
 *
 * Order is load-bearing: self-comparisons first, then vendor coverage, then
 * systematic errors, then our own thinness, then the rate.
 *
 * Self-comparisons come first because they invalidate every number below them —
 * `comparable`, `matched` and `theyHave` all count rows the vendor no longer
 * owns — so no downstream rung can be read until they are accounted for
 * (MONEY-1237).
 */
function judgeAgreementLadder(
  input: RatioGateInput,
  opts?: RatioGateThresholds,
): RatioGateJudgement {
  const minComparable = opts?.minComparable ?? RATIO_MIN_COMPARABLE;
  const vendorFloor = opts?.vendorFloor ?? RATIO_VENDOR_FLOOR;
  const passRate = opts?.passRate ?? RATIO_PASS_RATE;

  // Clamped rather than trusted. A negative or non-finite count is a caller bug,
  // and the damage it would otherwise do is silent: a negative denominator makes
  // `matchRate` compare false against every threshold, which reads as "fine" —
  // the same shape the 0/0-is-NaN case is already pinned against below. The
  // `Math.min` matters separately from the `Math.max`: without it the count
  // REPORTED on the judgement can exceed the population it was drawn from, and
  // `judgeRatiosGate` sums those into the number an operator reads.
  const n = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const selfComparisons = Math.min(
    n(input.selfComparisons),
    n(input.comparable),
  );
  const selfMatched = Math.min(n(input.selfMatched), n(input.matched));
  const independentComparable = Math.max(
    0,
    n(input.comparable) - selfComparisons,
  );
  const independentMatched = Math.max(0, n(input.matched) - selfMatched);

  /**
   * The caller could not say how many pairs were self-comparisons — MONEY-1237.
   *
   * `n()` would map a NaN to 0, and 0 is the PERMISSIVE value here: it means
   * "clean", which is a licence to read READY. "Couldn't determine" therefore
   * has to stay a distinct value all the way up to {@link judgeRatiosGate},
   * which is why the judgement below carries NaN rather than a clamped zero.
   * Collapsing it to the permissive default is the fail-open shape this whole
   * change exists to close.
   */
  const selfUnknown =
    !Number.isFinite(input.selfComparisons) ||
    !Number.isFinite(input.selfMatched);

  // The rate the ladder judges and the operator reads is the INDEPENDENT one.
  // Over the raw counts, a fully contaminated `roe` reads 100% by construction.
  const matchRate =
    independentComparable === 0
      ? 0
      : independentMatched / independentComparable;

  /** Everything below reports these two, so build them once. */
  const carry = { selfComparisons, independentComparable };

  // ── Rung 0: has the projection already been armed here? — MONEY-1237 ──
  //
  // Only fires when the exclusion actually costs us the ability to judge. A
  // ratio with 2,000 independent pairs and 3 contaminated ones is still
  // judgeable on its 2,000 — the 3 are simply gone from both sides of the
  // fraction, and `judgeRatiosGate` still fails the RUN over them.
  //
  // Checked BEFORE the vendor floor so the drained case cannot be reported as
  // "WE cannot derive what they could", which points the reader at our
  // derivation when the actual cause is that this environment's vendor rows were
  // overwritten by our own job.
  if (selfUnknown) {
    return {
      ratio: input.ratio,
      verdict: "UNVERIFIABLE",
      matchRate,
      independentComparable,
      // NOT `selfComparisons` (which `n()` would have flattened to 0, i.e.
      // "clean"). NaN is the distinct third value, and `judgeRatiosGate` fails
      // the run on it.
      selfComparisons: Number.NaN,
      reason:
        `the caller did not report how many pairs were self-comparisons, so ` +
        `this ratio is treated as CONTAMINATED rather than clean — a missing ` +
        `answer must not read as "no XBRL incumbents" on a one-way door`,
    };
  }

  if (selfComparisons > 0 && independentComparable < minComparable) {
    return {
      ratio: input.ratio,
      verdict: "UNVERIFIABLE",
      matchRate,
      ...carry,
      reason:
        `${selfComparisons} of ${n(input.comparable)} comparable pair(s) hold ` +
        `XBRL against ITSELF — the incumbent is already our own projection — ` +
        `leaving only ${independentComparable} independent pair(s) (floor ` +
        `${minComparable}). This run cannot judge this ratio: the vendor values ` +
        `it needed have already been overwritten. Re-run in an environment where ` +
        `XBRL_RATIOS_APPLY has never been armed`,
    };
  }

  // ── Rung 1.5: a DECLARED definitional divergence — MONEY-1250 ─────────
  //
  // The two sides are not measuring the same quantity, and the source documents
  // cannot close the difference. Grading such a pair produces a number that
  // looks like an accuracy score and is really a statement about vocabulary.
  //
  // ## Why it sits ABOVE the vendor floor rather than below it
  //
  // Not a stylistic choice — below the floor it would be INERT for exactly the
  // ratio it was written for. `debtToEquity` has 21 vendor rows against a floor
  // of 50, so it returns at the vendor-coverage rung and never reaches anything
  // placed after it; the declaration would have shipped, changed no output, and
  // read as done (the merged-≠-wired trap, MONEY-1220).
  //
  // It is also the right order on the merits. The vendor floor asks "is there
  // enough of their data to judge OURS?" — a question that only means something
  // once the two columns hold the same quantity. When they do not, no volume of
  // vendor rows makes the comparison informative, and printing "vendor coverage
  // too thin" points the reader at collection when the answer is definitional.
  // That mis-attribution is the same complaint this module's header makes about
  // the ladder MONEY-1235 replaced.
  //
  // ## What it must never do
  //
  // Suppress a systematic error the vendor side is big enough to evidence. A
  // definitional gap does not produce a power-of-ten error, so SCALE and SIGN
  // still win once `theyHave` clears the floor — the same "vendor coverage
  // first, because a scale mismatch over three rows is noise in a costume"
  // reasoning that orders the rungs below. Under the floor the systematic
  // counts are not evidence about anything, which is precisely why the
  // declaration may take precedence there.
  const declared = input.declaredDivergence;
  const systematicIsEvidenced =
    input.theyHave >= vendorFloor &&
    (input.scaleMismatches > 0 || input.signMismatches > 0);
  if (
    declared !== undefined &&
    declared.trim() !== "" &&
    !systematicIsEvidenced
  ) {
    return {
      ratio: input.ratio,
      verdict: "DECLARED_DIVERGENCE",
      matchRate,
      ...carry,
      reason:
        `NOT GRADED — our figure and the incumbent's are different quantities. ` +
        `${declared} This run makes no claim about this ratio in either ` +
        `direction: it is neither evidence of agreement nor of a defect, and it ` +
        `does NOT count toward the switchover`,
    };
  }

  if (input.theyHave < vendorFloor) {
    return {
      ratio: input.ratio,
      verdict: "UNVERIFIABLE",
      matchRate,
      ...carry,
      reason:
        input.theyHave === 0
          ? `no vendor data at all (we derived ${input.weHave}); nothing to ` +
            `reconcile against, in either direction — does NOT block`
          : `vendor coverage too thin (${input.theyHave} rows, floor ` +
            `${vendorFloor}) — does NOT block`,
    };
  }

  // Only meaningful once the vendor side is real. A power-of-ten or sign
  // disagreement is never averaged away.
  //
  // NOT discounted by `selfComparisons` — MONEY-1237. Our own writer disagreeing
  // with our own projection by a factor of ten is a real defect, and discounting
  // a BLOCKER is the one direction that can manufacture a false READY.
  if (input.scaleMismatches > 0 || input.signMismatches > 0) {
    return {
      ratio: input.ratio,
      verdict: "BLOCKED",
      matchRate,
      ...carry,
      reason:
        `systematic error: scale ${input.scaleMismatches}, sign ` +
        `${input.signMismatches} — fix it, do not widen the tolerance`,
    };
  }

  // Thin while the vendor HAS the data means we cannot derive what they could.
  //
  // Reached only with `selfComparisons === 0` (rung 0 owns the drained case), so
  // `independentComparable` is `comparable` here and the attribution is safe.
  if (independentComparable < minComparable) {
    return {
      ratio: input.ratio,
      verdict: "BLOCKED",
      matchRate,
      ...carry,
      reason:
        `only ${independentComparable} comparable pair(s) (floor ` +
        `${minComparable}) while the vendor carries ${input.theyHave}: WE ` +
        `cannot derive what they could`,
    };
  }

  if (matchRate < passRate) {
    return {
      ratio: input.ratio,
      verdict: "BLOCKED",
      matchRate,
      ...carry,
      reason:
        `match rate ${(matchRate * 100).toFixed(1)}% over ` +
        `${independentComparable} independent pair(s), below the ` +
        `${(passRate * 100).toFixed(0)}% gate`,
    };
  }

  return {
    ratio: input.ratio,
    verdict: "READY",
    matchRate,
    ...carry,
    reason:
      `${independentMatched}/${independentComparable} within tolerance` +
      (selfComparisons > 0
        ? ` (${selfComparisons} XBRL-vs-XBRL pair(s) excluded; the RUN still ` +
          `fails while any exist)`
        : ""),
  };
}

/**
 * Judge ONE ratio: the agreement ladder, PLUS the fill-rate rung — MONEY-1401.
 *
 * ## Why the fill rung is a wrapper rather than another rung in the ladder
 *
 * Both directions of masking are wrong, and a position inside the ladder picks
 * one of them:
 *
 *   - placed EARLY, a fill regression hides a systematic error. `roce` on prod
 *     carries 49 sign mismatches AND a fill regression; an operator told only
 *     about the second would "fix" coverage and re-run into the first.
 *   - placed LATE, an agreement rung that returns first hides the fill
 *     regression entirely — which is the state this gate shipped in, where
 *     `roe` read READY on a 95.9% match rate while our derivation covered TEN
 *     FEWER symbols than the column it was about to overwrite.
 *
 * So the fill verdict is computed UNCONDITIONALLY, carried on every judgement
 * whatever the ladder said, and can only ever make a verdict STRICTER: it
 * upgrades a non-blocking verdict to BLOCKED and otherwise appends its finding
 * to the reason the ladder already gave. It never rescues a BLOCK, for the same
 * reason the scale/sign rung is never discounted — that is the one direction
 * that can manufacture a false READY.
 *
 * THE COUNTS ARE A SEPARATE CENSUS, and that is the F8 correction. This used
 * to read "`weHave` / `theyHave` ARE the fill counts; nothing new has to be
 * measured" — true of the fields and false of the question. Those two are the
 * GRADER's population, joined on the FILING's exchange; the writer keys on the
 * INSTRUMENT's and refuses 92.3% of them. {@link RatioGateInput.fill} is the
 * writer's own population, measured by the caller, and it is a REQUIRED field
 * so the omission cannot be silent.
 */
export function judgeRatioReadiness(
  input: RatioGateInput,
  opts?: RatioGateThresholds,
): RatioGateJudgement {
  // The WRITER's population, not the grader's — MONEY-1401 F8. See
  // `judgeRatioFill`; this line used to read `input.weHave, input.theyHave`,
  // which counted 92.3% rows the writer refuses.
  const fill = judgeRatioFill(input.ratio, input.fill.xbrl, input.fill.vendor);
  // MONEY-1401 F8b — the agreement rungs above grade the FILING's exchange; the
  // writer keys on the INSTRUMENT's. Computed UNCONDITIONALLY and carried on
  // every judgement, for the same reason `fill` is: a rung that only runs on
  // some paths is a rung wired at three of four.
  const writable =
    input.writable === undefined
      ? undefined
      : judgeWritableAgreement(
          input.writable.comparable,
          input.writable.matched,
          opts,
        );
  const base = judgeAgreementLadder(input, opts);
  const carry = { ...base, fill, ...(writable ? { writable } : {}) };

  // Both extra rungs are STRICT-ONLY: each can upgrade a non-blocking verdict
  // to BLOCKED and neither can ever rescue one. Collected rather than nested so
  // a ratio failing BOTH reports both — the F8 header's own complaint about a
  // fill regression hiding a systematic error, one rung over.
  const notes: string[] = [];
  let blocks = false;
  if (fill.verdict !== "OK") {
    notes.push(
      `FILL ${fill.verdict}: we derive ${input.ratio} for ${fill.xbrl} symbol(s) ` +
        `against the incumbent's ${fill.vendor} — arming would REPLACE a populated ` +
        `column with an emptier one. The agreement rungs cannot see this: they only ` +
        `compare rows that exist on both sides, so a ratio derived for nobody scores ` +
        `100% on the few it is derived for`,
    );
    blocks ||= fill.verdict === "BLOCK";
  }
  if (writable?.verdict === "BLOCK") {
    notes.push(
      `WRITABLE-COHORT DISAGREEMENT: ${writable.matched}/${writable.comparable} ` +
        `(${(writable.matchRate * 100).toFixed(1)}%) of the pairs on symbols the ` +
        `WRITER CAN ACTUALLY REACH agree, below the ` +
        `${((opts?.passRate ?? RATIO_PASS_RATE) * 100).toFixed(0)}% gate. The ` +
        `ladder above grades the FILING's exchange and the writer keys on the ` +
        `INSTRUMENT's, so its rate is dominated by rows arming would never ` +
        `write — a ratio can agree across that cohort and disagree on every row ` +
        `that actually gets stored`,
    );
    // ── THE CARVE-OUT THE FILL RUNG HAS AND THIS ONE DID NOT ──────────────
    //
    // A DECLARED_DIVERGENCE says our figure and the incumbent's ARE NOT THE
    // SAME QUANTITY. Restricting those pairs to the writer's cohort does not
    // make them comparable — it grades the same non-comparison over fewer
    // rows — so blocking on the rate is the gate faulting a ratio for the one
    // reason it has already declared is not a defect, permanently and with no
    // way to clear it.
    //
    // `judgeRatioFill` has this carve-out implicitly: `FILL_BLOCKING_RATIOS`
    // is {roe, roce, netMargin} and `debtToEquity` — today's only declared
    // ratio — is not in it, so a fill regression there WARNs. This rung had no
    // list and no exception. Latent on the 2026-09-14 run only because
    // `debtToEquity`'s writable cohort is 0 pairs -> NOT_MEASURED; it arms
    // itself the moment `reresolve-xbrl-instruments.ts` grows the cohort past
    // {@link RATIO_MIN_COMPARABLE}. Executed at `writable {120, 6}`: verdict
    // BLOCKED, run `pass: false`, `blocked: ["debtToEquity"]`.
    //
    // The note is still PUSHED, so the disagreement is printed rather than
    // hidden — the same treatment a non-blocking fill WARN gets.
    blocks ||= base.verdict !== "DECLARED_DIVERGENCE";
  }
  /**
   * NOT MEASURED IS NOT A PASS — the F8b hole, closed.
   *
   * `judgeWritableAgreement` abstains below {@link RATIO_MIN_COMPARABLE}, and
   * nothing downstream read that verdict: `judgeRatiosGate`'s `pass` term is
   * `o.pass && !identityBlocked && !fillUnmeasured`, with no `writable` term at
   * all. So a ratio that agreed across the 92.3% of rows the writer refuses and
   * was never measured on the rows it stores read READY, `blocked` empty, `pass`
   * true — a FALSE READY on a one-way door, which is the worst outcome this
   * gate has.
   *
   * UNVERIFIABLE, not BLOCKED: nothing disagreed. It is the vocabulary this
   * module already uses for "this run could not conclude", it is never counted
   * toward a pass (`ready.length === 0` fails the run), and it does not block —
   * the same polarity as the vendor floor one rung down, which abstains for the
   * same reason about the other side of the comparison.
   *
   * Only a READY is downgraded. A ladder that already said BLOCKED or
   * UNVERIFIABLE or DECLARED_DIVERGENCE keeps its own, more actionable answer.
   */
  const readyButUnmeasured =
    writable?.verdict === "NOT_MEASURED" && base.verdict === "READY";
  if (readyButUnmeasured) {
    notes.push(
      `WRITABLE COHORT NOT MEASURED: only ${writable.comparable} comparable ` +
        `pair(s) sit on symbols the WRITER CAN ACTUALLY REACH, below the floor ` +
        `of ${opts?.minComparable ?? RATIO_MIN_COMPARABLE}. The agreement above ` +
        `is a statement about the derivation over a population 92% of which ` +
        `arming never writes; it is NOT evidence about the rows that get ` +
        `stored, and a gate cannot call READY on a one-way door from evidence ` +
        `it does not have. Run scripts/data/reresolve-xbrl-instruments.ts to ` +
        `grow the cohort and re-run`,
    );
  }
  if (notes.length === 0) return carry;

  const note = notes.join(" — also ");
  // A BLOCK over a verdict that would not have blocked. The ladder's answer is
  // still printed, because "READY on agreement, BLOCKED on coverage" is two
  // facts and collapsing them sends the reader to the wrong place.
  if (blocks && base.verdict !== "BLOCKED") {
    return {
      ...carry,
      verdict: "BLOCKED",
      reason: `${note} (agreement alone said ${base.verdict}: ${base.reason})`,
    };
  }
  // Strictly weaker than the BLOCK above, so it is checked second: a ratio whose
  // fill BLOCKS and whose writable cohort is unmeasured is BLOCKED, not merely
  // unverified.
  if (readyButUnmeasured) {
    return {
      ...carry,
      verdict: "UNVERIFIABLE",
      reason: `${note} (agreement alone said READY: ${base.reason})`,
    };
  }
  // A non-blocking note, or a BLOCK on a verdict that already blocks: the
  // ladder's own reason is the more actionable one and is kept as the headline.
  return { ...carry, reason: `${base.reason} — ${note}` };
}

/**
 * Facts about the RUN that no per-ratio judgement can carry — MONEY-1401.
 *
 * ## Why this is one optional parameter rather than two required fields
 *
 * `judgeRatiosGate` is called with hand-built judgement literals throughout
 * `xbrl-ratios-gate.test.ts`, where the run-level rungs are not the subject.
 * Absence therefore means "this caller is not exercising the run-level rungs",
 * which the summary states in those words rather than silently scoring.
 *
 * That is a weaker guarantee than {@link RatioGateInput.selfComparisons}'s
 * required field, and deliberately so: the permissive reading there is a gate
 * CERTIFYING ITSELF, while the permissive reading here is a gate that says less
 * than it could. The PRODUCTION caller is pinned separately — the source scan
 * in `xbrl-ratios-self-comparison-wiring.test.ts` fails if
 * `scripts/data/xbrl-ratios-validate.ts` stops passing a context.
 */
export interface RatiosRunContext {
  /**
   * The BALANCE-SHEET IDENTITY over the filings actually used — the check that
   * survives the vendor being dead. See {@link checkBalanceIdentity}.
   *
   * `uncheckable` is reported and NEVER folded into `passed`: a filing missing
   * a leg did not balance, it was not measured, and treating the two the same
   * is how a parser that stopped emitting `totalLiabilities` would score 100%.
   */
  identity: { passed: number; failed: number; uncheckable: number };
  /**
   * Symbols where WE hold data and the vendor holds NO ROW AT ALL — MONEY-1401.
   *
   * Invisible to every other rung by construction: with no incumbent there is
   * no pair, so these symbols contribute to no `comparable`, no `matched` and
   * no rate. They are the SWITCHOVER'S ENTIRE UPSIDE (coverage the vendor never
   * had) and simultaneously the population about which this gate can say
   * nothing whatsoever. Reported so the reader knows the size of what was not
   * graded; never counted toward a pass.
   */
  cannotGrade: {
    count: number;
    /** Largest first, by whatever size measure the caller could reach. */
    top: readonly { symbol: string; marketCap: number | null }[];
  };
  /**
   * How many symbols the FILL CENSUS was taken over — MONEY-1401 F8.
   *
   * ## Why a size, when the census itself is per-ratio
   *
   * Because {@link judgeRatioFill} compares two counts and `0 >= 0` is OK. An
   * EMPTY writable population therefore makes every fill verdict read OK, on
   * every ratio, for ever — the rung going quiet in exactly the state it exists
   * to detect, which is the F9 defect one rung over. Naming that hazard in a
   * comment is not protection from it, so it is a threshold.
   *
   * It is run-level rather than per-ratio deliberately: the census population
   * is one set of symbols and every ratio is counted over it, so a per-ratio
   * copy would be one number repeated six times with six chances to disagree.
   *
   * Measured on prod 2026-09-13: 183 of 2,468 graded symbols are
   * writer-reachable — low because `scripts/data/reresolve-xbrl-instruments.ts`
   * has not run, and ~2,000 once it has.
   */
  fillPopulation: number;
  /**
   * `writerReachableSymbols(...).size` — the cohort BOTH other populations are
   * drawn from. MONEY-1401 F8b review.
   *
   * ## It exists to make two mutations FAIL, not to be printed
   *
   * The writer-reachable rule was moved into {@link writerReachableSymbols} so
   * it could be tested, and the CALLER's use of it stayed a source scan. A
   * source scan proves a call site exists, never which expression is inside it,
   * and both mutations that matter passed the whole suite:
   *
   *   - `writable: writerReachable.has(f.symbol)` -> `writable: true` in the
   *     grading loop. The writable cohort becomes the GRADED cohort and the
   *     rung can never block anything the ladder did not. 176/176 green.
   *   - `if (!writerReachable.has(f.symbol)) continue;` DELETED from the fill
   *     census. The 92.3% over-count is silently restored. 176/176 green.
   *
   * Both are caught ARITHMETICALLY here, because both produce a population
   * LARGER than the set it was drawn from, and that is impossible in correct
   * code:
   *
   *   `fillPopulation <= writerReachable`              (the census filters it)
   *   `judgement.writable.comparable <= writerReachable`  (one pair per symbol
   *                                                        per ratio, tagged
   *                                                        from the same set)
   *
   * A violation is a CONTRADICTION between two numbers the caller measured, so
   * nothing else in the run can be believed and it fails outright — never
   * clamped to the plausible value, which would restore the defect and print a
   * healthy number.
   *
   * A further mutation that ALSO lies here (passing `newest.size`) defeats it;
   * that is one deliberate edit past the two the review found, and the scan in
   * `xbrl-ratios-writable-cohort.test.ts` still pins where this comes from.
   */
  writerReachable: number;
}

export interface RatiosGateOutcome {
  pass: boolean;
  ready: string[];
  blocked: string[];
  unverifiable: string[];
  /**
   * Ratios NOT GRADED because the two sides measure different quantities —
   * MONEY-1250. Kept apart from {@link unverifiable}: that one means "the
   * vendor has too little data", this one means "no amount of their data would
   * help". Never counted as verification.
   */
  declared: string[];
  /**
   * Total XBRL-vs-XBRL pairs across every ratio. Non-zero means the projection
   * has already been armed in this environment and the run cannot serve as
   * arming evidence, whatever the per-ratio verdicts say. MONEY-1237.
   */
  selfComparisons: number;
  /**
   * Share of CHECKABLE filings whose balance sheet did not balance, or
   * `undefined` when the caller passed no {@link RatiosRunContext}. NaN is not
   * used: "not measured" and "measured as zero" must stay distinguishable, and
   * NaN compares false against every threshold, which reads as "fine".
   */
  identityFailRate?: number;
  /** {@link RatiosRunContext.cannotGrade}'s count, echoed for a caller that prints. */
  cannotGrade?: number;
  /** One sentence naming the outcome and what was NOT proven. */
  summary: string;
}

/**
 * Roll per-ratio judgements into the run's verdict.
 *
 * Passing requires THREE things: that no judged pair was a self-comparison, that
 * nothing blocked, AND that something was actually verified. The last two are
 * the all-unverifiable trap in the header; the first is the self-comparison trap
 * (MONEY-1237). An empty input fails for the same reason as the second: it is a
 * gate that compared nothing.
 */
export function judgeRatiosGate(
  judgements: readonly RatioGateJudgement[],
  context?: RatiosRunContext,
): RatiosGateOutcome {
  // ── RUN-LEVEL RUNGS — MONEY-1401 ──────────────────────────────────────
  //
  // Both are folded in by `done()` below rather than by four copies of the same
  // three lines: this function has four exits and every one of them has to
  // carry them, which is precisely the shape that ships wired at three of four.
  const identityChecked =
    context === undefined
      ? undefined
      : context.identity.passed + context.identity.failed;
  const identityFailRate =
    context === undefined ||
    identityChecked === undefined ||
    identityChecked === 0
      ? undefined
      : context.identity.failed / identityChecked;
  /**
   * The rung was not MEASURED — MONEY-1401 F9, and it BLOCKS.
   *
   * `identityChecked === 0` used to produce `identityFailRate: undefined` ->
   * `identityBlocked: false` -> a PASSING run, with no
   * {@link RATIO_MIN_COMPARABLE} analogue anywhere. So the one failure this
   * rung's own docstring names — "a parser that stopped emitting
   * `totalLiabilities` would score 100%" — arrived as NOT-MEASURED and waved
   * the run through. A rung that goes quiet exactly when it breaks is a
   * monitor over a series nobody produces (MONEY-1238).
   *
   * Only when a context was supplied: `context === undefined` means this
   * CALLER is not exercising the run-level rungs at all, which the summary
   * already states in those words and which the source scan in
   * `xbrl-ratios-self-comparison-wiring.test.ts` keeps the production caller
   * out of.
   */
  const identityUnmeasured =
    context !== undefined &&
    (identityChecked ?? 0) < BALANCE_IDENTITY_MIN_CHECKED;
  const identityBlocked =
    identityUnmeasured ||
    (identityFailRate !== undefined &&
      identityFailRate > BALANCE_IDENTITY_MAX_FAIL_RATE);

  /**
   * The FILL CENSUS was taken over too few symbols to mean anything — F8.
   *
   * `judgeRatioFill` compares two counts, and `0 >= 0` is OK. So an empty
   * writer-reachable population makes EVERY ratio's fill verdict read OK, on
   * every run, for ever — which is the same "quiet exactly when it breaks"
   * shape as `identityUnmeasured` above, in the rung that was added to catch
   * the thing the agreement rungs are blind to.
   */
  const fillUnmeasured =
    context !== undefined && context.fillPopulation < FILL_MIN_POPULATION;

  /**
   * A READY that carries NO writable information at all — F8b review, LOW-10.
   *
   * {@link judgeRatioReadiness} downgrades a READY whose writable cohort was
   * MEASURED AND THIN. This is the other absence: the caller passed no
   * {@link RatioGateInput.writable} whatsoever, which printed `?/?` with no
   * verdict suffix and had no term in `pass`.
   *
   * Gated on `context !== undefined` for the same reason `identityUnmeasured`
   * is: absence of a context means the caller is a hand-built test literal
   * exercising the ladder, and the summary says so in those words. A caller
   * that DOES measure the run — the production one — must have measured the
   * cohort too, or its READY is a claim about rows nobody looked at.
   */
  const readyWithoutWritable =
    context !== undefined &&
    judgements.some((j) => j.verdict === "READY" && j.writable === undefined);

  /**
   * A population LARGER than the set it was drawn from — see
   * {@link RatiosRunContext.writerReachable}. Impossible in correct code, and
   * the arithmetic signature of both mutations the F8b review found.
   */
  const cohortContradictions =
    context === undefined
      ? []
      : [
          ...(context.fillPopulation > context.writerReachable
            ? [
                `the FILL CENSUS covered ${context.fillPopulation} symbol(s) ` +
                  `out of ${context.writerReachable} writer-reachable — the ` +
                  `census is not filtered by reachability`,
              ]
            : []),
          ...judgements
            .filter(
              (j) => (j.writable?.comparable ?? 0) > context.writerReachable,
            )
            .map(
              (j) =>
                `${j.ratio}'s writable cohort holds ` +
                `${j.writable?.comparable ?? 0} pair(s) out of ` +
                `${context.writerReachable} writer-reachable symbol(s) — the ` +
                `pairs are not tagged by reachability`,
            ),
        ];
  const cohortContradiction = cohortContradictions.length > 0;

  const runNote =
    context === undefined
      ? ` The RUN-LEVEL rungs were NOT MEASURED by this caller (no ` +
        `RatiosRunContext): the balance-sheet identity and the ungradeable ` +
        `population are unknown here, not clean.`
      : (identityUnmeasured
          ? ` BALANCE-SHEET IDENTITY: only ${identityChecked ?? 0} filing(s) ` +
            `were checkable (${context.identity.uncheckable} missing a leg), ` +
            `below the floor of ${BALANCE_IDENTITY_MIN_CHECKED} — so the run ` +
            `FAILS. That is a structural finding about the projection, not a ` +
            `clean sheet: a rung that goes quiet when it breaks would wave ` +
            `through the exact regression it exists to catch (a parser that ` +
            `stopped emitting totalLiabilities scores NOT-MEASURED, not 0%).`
          : ` BALANCE-SHEET IDENTITY: ` +
            `${context.identity.failed} of ${identityChecked} checkable ` +
            `filing(s) do NOT balance ` +
            `(${((identityFailRate ?? 0) * 100).toFixed(1)}%, ceiling ` +
            `${(BALANCE_IDENTITY_MAX_FAIL_RATE * 100).toFixed(0)}%)` +
            (identityBlocked
              ? ` — OVER THE CEILING, so the run FAILS on our own arithmetic ` +
                `regardless of what the vendor says. This is the rung that ` +
                `survives the vendor being dead.`
              : `.`) +
            ` ${context.identity.uncheckable} filing(s) were UNCHECKABLE ` +
            `(a missing leg is not a pass).`) +
        ` FILL CENSUS taken over ${context.fillPopulation} writer-reachable ` +
        `symbol(s)` +
        (fillUnmeasured
          ? ` — BELOW the floor of ${FILL_MIN_POPULATION}, so the run FAILS: ` +
            `two counts over an empty population always agree.`
          : `.`) +
        ` ${context.cannotGrade.count} symbol(s) hold XBRL data and NO vendor ` +
        `row at all: this gate is SILENT about them — they are neither graded ` +
        `nor passed, and they are the switchover's entire coverage upside.` +
        (readyWithoutWritable
          ? ` A READY ratio reported NO writable-cohort agreement at all, so ` +
            `the run FAILS: this caller measured the run and must measure the ` +
            `rows arming would store.`
          : ``) +
        (cohortContradiction
          ? ` COHORT CONTRADICTION, so the run FAILS — ` +
            `${cohortContradictions.join("; ")}. These are two numbers this ` +
            `same caller measured and one cannot exceed the other; nothing ` +
            `else in this run can be believed.`
          : ``);

  const done = (
    o: Omit<RatiosGateOutcome, "identityFailRate" | "cannotGrade">,
  ): RatiosGateOutcome => ({
    ...o,
    // The run-level rungs can only ever make the run STRICTER, never rescue it.
    pass:
      o.pass &&
      !identityBlocked &&
      !fillUnmeasured &&
      !readyWithoutWritable &&
      !cohortContradiction,
    identityFailRate,
    ...(context === undefined
      ? {}
      : { cannotGrade: context.cannotGrade.count }),
    summary:
      (cohortContradiction && o.pass
        ? `NOT ready — a COHORT CONTRADICTION: ` +
          `${cohortContradictions.join("; ")}. `
        : "") +
      (readyWithoutWritable && o.pass && !cohortContradiction
        ? `NOT ready — a READY ratio carries NO writable-cohort agreement, so ` +
          `nothing was measured on the rows arming would actually store. `
        : "") +
      (fillUnmeasured && o.pass && !identityBlocked
        ? `NOT ready — the FILL CENSUS covered only ` +
          `${context?.fillPopulation ?? 0} writer-reachable symbol(s), below ` +
          `the floor of ${FILL_MIN_POPULATION}, so "ours >= theirs" is an ` +
          `absence of data rather than a finding. `
        : "") +
      (identityBlocked && o.pass
        ? (identityUnmeasured
            ? `NOT ready — the BALANCE-SHEET IDENTITY rung was NOT MEASURED ` +
              `on enough filings to be evidence. `
            : `NOT ready — the BALANCE SHEET DOES NOT BALANCE on too many of ` +
              `the filings this run graded. `) + o.summary
        : o.summary) +
      runNote,
  });

  const ready = judgements
    .filter((j) => j.verdict === "READY")
    .map((j) => j.ratio);
  const blocked = judgements
    .filter((j) => j.verdict === "BLOCKED")
    .map((j) => j.ratio);
  const unverifiable = judgements
    .filter((j) => j.verdict === "UNVERIFIABLE")
    .map((j) => j.ratio);
  const declared = judgements
    .filter((j) => j.verdict === "DECLARED_DIVERGENCE")
    .map((j) => j.ratio);

  // A judgement that cannot SAY how many of its pairs were self-comparisons is
  // treated as contaminated, not as clean. The type makes the field mandatory
  // precisely so this cannot happen, but "couldn't determine" must never
  // collapse into the permissive value on a one-way door.
  const unanswered = judgements.filter(
    (j) => !Number.isFinite(j.selfComparisons),
  ).length;
  const selfComparisons = judgements.reduce(
    (sum, j) =>
      sum +
      (Number.isFinite(j.selfComparisons) ? Math.max(0, j.selfComparisons) : 0),
    0,
  );

  const unverifiableNote =
    (unverifiable.length > 0
      ? ` ${unverifiable.length} ratio(s) UNVERIFIABLE (${unverifiable.join(", ")}) — ` +
        `the vendor carries too few rows, so this run is silent about them and ` +
        `they must be judged by unit tests and spot checks, not by this gate.`
      : "") +
    // NAMED SEPARATELY, never folded into the unverifiable count — MONEY-1250.
    // "Too few vendor rows" invites the reader to go get more rows. "Different
    // quantity" tells them that would not help, which is a different next step.
    (declared.length > 0
      ? ` ${declared.length} ratio(s) NOT GRADED by declared definitional ` +
        `divergence (${declared.join(", ")}) — our figure and the incumbent's ` +
        `are not the same quantity, so this run neither verified nor faulted ` +
        `them. That is a DELIBERATE non-claim, not an agreement.`
      : "");

  // ── Contamination outranks everything — MONEY-1237 ──
  //
  // Reported FIRST, and as the headline rather than a footnote, because it
  // invalidates the population every other line was measured over: a BLOCKED
  // here is a disagreement between our writer and our projection, and a READY
  // is at best a statement about whatever independent pairs survived. The
  // reconcile's equivalent guard is a `log.warn` that never reaches its
  // `allReady`, so a fully contaminated financials run still prints "every
  // field is READY" — that is the outcome this branch exists to not repeat.
  if (selfComparisons > 0 || unanswered > 0) {
    return done({
      pass: false,
      ready,
      blocked,
      unverifiable,
      declared,
      selfComparisons,
      summary:
        `NOT ready — THIS ENVIRONMENT'S INCUMBENTS ARE PARTLY OURS. ` +
        (unanswered > 0
          ? `${unanswered} ratio(s) did not report a self-comparison count, ` +
            `which is treated as contaminated rather than clean. `
          : "") +
        `${selfComparisons} comparison pair(s) hold XBRL against ITSELF, so ` +
        `XBRL_RATIOS_APPLY has already been armed here and StockRatios no ` +
        `longer holds the vendor values this gate needs (it keeps no \`source\` ` +
        `history, so they are gone, not hidden). Those pairs are excluded from ` +
        `every rate above, but no run in this environment can be arming ` +
        `evidence again — re-run against one where the projection has never ` +
        `been armed.` +
        (blocked.length > 0 ? ` Also BLOCKED: ${blocked.join(", ")}.` : "") +
        unverifiableNote,
    });
  }

  if (blocked.length > 0) {
    return done({
      pass: false,
      ready,
      blocked,
      unverifiable,
      declared,
      selfComparisons,
      summary:
        `NOT ready. BLOCKED: ${blocked.join(", ")}. Do NOT point any reader at ` +
        `XBRL-derived ratios.` +
        unverifiableNote,
    });
  }

  if (ready.length === 0) {
    return done({
      pass: false,
      ready,
      blocked,
      unverifiable,
      declared,
      selfComparisons,
      summary:
        `NOT ready — nothing was actually verified. This run compared nothing ` +
        `it could conclude from.` +
        unverifiableNote,
    });
  }

  return done({
    pass: true,
    ready,
    blocked,
    unverifiable,
    declared,
    selfComparisons,
    summary:
      `No ratio is BLOCKED and ${ready.length} is/are READY (${ready.join(", ")}) ` +
      `— evidenced as far as vendor overlap allows, over INDEPENDENT pairs only ` +
      `(0 XBRL-vs-XBRL self-comparisons).` +
      unverifiableNote,
  });
}
