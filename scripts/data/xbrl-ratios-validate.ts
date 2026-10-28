#!/usr/bin/env tsx
/**
 * XBRL-derived ratios vs Tickertape — MONEY-1204 (P14 / 14a.4).
 *
 * READ-ONLY. Writes nothing, ever. The ratios half of the P10 switchover gate:
 * `xbrl-reconcile.ts` answers it for `StockFinancials`, this answers it for
 * `StockRatios`, and the two are NOT the same question.
 *
 * ## Why this cannot reuse xbrl-reconcile's shape
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])` — a value per PERIOD, so an XBRL quarter and a Tickertape quarter
 * describe the same window and are directly comparable.
 *
 * `StockRatios` is `@@unique([symbol, exchange])`. **One row per symbol, no
 * period dimension at all.** It is a current snapshot, and Tickertape publishes
 * it on a trailing-twelve-month basis.
 *
 * That difference is the whole design problem here, and getting it wrong
 * produces a confident wrong verdict:
 *
 *   `deriveRatios` DELIBERATELY does not annualise ROE/ROA on a quarterly
 *   filing — its own comment says multiplying a seasonal quarter by four is "a
 *   forecast dressed as a measurement". Indian earnings are strongly seasonal.
 *   So a quarterly-derived ROE is roughly a quarter of a TTM ROE, and comparing
 *   the two directly yields a systematic ~75% "disagreement" on nearly every
 *   symbol.
 *
 *   A naive validator would then report the switchover BLOCKED — not because
 *   XBRL is wrong, but because it compared a quarter against a year. The gate
 *   would be failing for a reason that has nothing to do with data quality, and
 *   the obvious "fix" (loosen the tolerance until it passes) would hide a real
 *   scale error behind the same slack.
 *
 * So: **only ANNUAL filings are compared**, and a symbol whose newest filing is
 * quarterly is counted `NO_ANNUAL_FILING` — a distinct outcome, never folded
 * into a match rate. If most of the universe lands there, the honest verdict is
 * "not enough annual coverage to judge", which is different from "the numbers
 * disagree" and calls for a different action.
 *
 * ## Why banks are excluded rather than tolerated
 *
 * The spec's gate is "≥95% of NON-BANK ratios within 5%". Banking ratios are
 * DISCLOSED (GNPA/NNPA/CET1), not derived, and a bank's debt-to-equity is not
 * comparable to an industrial's by construction — deposits are not debt in the
 * sense the ratio assumes. Including them would pollute the rate with rows that
 * were never meant to be judged this way. `XbrlFiling.filerKind` carries the
 * classification the filer itself declared.
 *
 * ## Why an incumbent stamped NSE_XBRL is fatal, not a footnote — MONEY-1237
 *
 * This script SELECTED `stock_ratios.source` and then never read it. The two
 * occurrences of `source` in the file were the `select` and the type annotation.
 *
 * The gate's premise is that the incumbent is a VENDOR value about to be
 * destroyed. `StockRatios` is `@@unique([symbol, exchange])` with no `source` in
 * the key, so the first XBRL write for a symbol overwrites the vendor row and
 * keeps no history of it. After that, the "incumbent" is our own projection and
 * the comparison is XBRL against XBRL: a tautological MATCH.
 *
 * `XBRL_RATIOS_APPLY` arms the ratios job — MONEY-1286 split it from
 * `XBRL_PROJECTION_APPLY` precisely because the two gates disagreed on prod, so
 * is the DEFAULT path into the trap, not an exotic one — flip it in QA to try
 * it, or re-run the gate on prod after arming to "confirm it worked", and the
 * incumbents are already `NSE_XBRL`. `roe` is the only ratio with real vendor
 * coverage (2,038 of 2,135 rows on prod 2026-08-21, against 0 / 86 / 85 / 86 for
 * operatingMargin / netMargin / roa / debtToEquity), so a contaminated `roe`
 * matches itself 100%, reads READY, and `judgeRatiosGate` passes the run on one
 * READY plus four UNVERIFIABLE. The switchover would be evidenced by XBRL
 * against XBRL.
 *
 * The counting and the consequence both live in `judgeRatioReadiness` /
 * `judgeRatiosGate` — pure and unit-tested — not here. This script's job is to
 * TAG each pair with its incumbent's provenance, hand the counts over, and
 * print. See that module's header for why self-comparisons are excluded from
 * both sides of every rate AND fail the run, and why that diverges from
 * `xbrl-reconcile.ts`, whose equivalent guard is a `log.warn` its `allReady`
 * never reads.
 *
 * ## Why one ratio is not graded at all — MONEY-1250
 *
 * `debtToEquity` carries a DECLARED definitional divergence and returns
 * `DECLARED_DIVERGENCE`: our `totalDebt` is borrowings only, the incumbent's
 * also contains Ind-AS 116 lease liabilities, and the integrated-filing
 * taxonomy publishes no lease-liability balance element with which to close the
 * gap. That verdict is neither a pass nor a block and is named separately in
 * the summary, because "we chose not to grade this" must never be legible as
 * "this agreed". The evidence lives beside the declaration in
 * {@link DECLARED_DIVERGENCES} rather than in a commit message.
 *
 * ## Why two SYMBOLS are not graded at all — MONEY-1255 (D3)
 *
 * CENTUM and DVL are removed from every rate by {@link EXCLUDED_SYMBOLS}. That
 * is a DIFFERENT instrument from the paragraph above and a weaker one, and the
 * report says so in those words: a declaration explains why two sides measure
 * different quantities, while an exclusion explains nothing — it agrees to arm
 * over rows already found to be wrong. Both symbols carry the only two
 * surviving `roe` SIGN_MISMATCHes, both from the attributable-vs-profitForPeriod
 * ambiguity documented at `xbrl-projection.ts:1069`.
 *
 * Declaring `roe` instead would have been far worse than excluding two symbols:
 * `roe` is the ONLY ratio with real vendor coverage, so removing it leaves the
 * gate passing on four UNVERIFIABLE lines — MONEY-1237's self-comparison trap
 * reached from the other direction.
 *
 * The block prints BEFORE the per-ratio ladder, prints a row for every declared
 * symbol INCLUDING one that removed nothing, and leaves the offending pairs in
 * the worst-offenders list (labelled, sorted last) because those numbers are the
 * evidence the exclusion rests on.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/xbrl-ratios-validate.ts
 *   npx tsx scripts/data/xbrl-ratios-validate.ts --symbols=TCS,INFY --verbose
 *   npx tsx scripts/data/xbrl-ratios-validate.ts --limit=100
 *
 * Prefer the wrapper so DATABASE_URL comes from Secret Manager:
 *   ./scripts/ops/run-market-data-job.sh xbrlratios prod
 *
 * Exits 1 when the gate does NOT pass, so it can be read by a script as well as
 * by a person. Exits 1 ALSO when nothing was comparable — "we compared nothing"
 * must never read as "everything matched" (MONEY-1196's draining denominator).
 */

import prisma from "@usemoney/database";
import {
  vendorComparablePeriodEnd,
  isLenderFamily,
  deriveRatios,
  selectFilingForPeriod,
  judgeRatioReadiness,
  judgeRatiosGate,
  RATIO_MIN_COMPARABLE,
  RATIO_VENDOR_FLOOR,
  RATIO_PASS_RATE,
  // The exact string the projection writer stamps. Imported rather than spelled
  // "NSE_XBRL" here so the gate and the writer cannot drift into two spellings
  // of the same source — a drift that would make this check silently pass
  // everything. MONEY-1237.
  XBRL_SOURCE,
  // MONEY-1255 (D3) — the SAME accounting the financials reconcile uses for its
  // symbol exclusions, imported rather than re-implemented. It seeds from the
  // DECLARED list rather than from the rows, which is the whole reason a symbol
  // that removes nothing still prints; a second copy here would be free to lose
  // that property quietly. See {@link EXCLUDED_SYMBOLS}.
  tallySymbolExclusions,
  // MONEY-1401 — the two rungs that need no vendor at all. Both live in the
  // pure module beside the ladder; this script measures and hands over.
  checkBalanceIdentity,
  projectFinancials,
  type BalanceIdentityVerdict,
  type RatiosRunContext,
  type RatioGateJudgement,
  type XbrlFinancials,
  // MONEY-1401 F8 — the FILL census must ask what the WRITE PLAN would fill,
  // not what `deriveRatios` could produce. `isPlanWorthWriting` is the row-level
  // veto the writer applies before any column is written at all, so a plan it
  // refuses contributes ZERO to every column rather than its columns each.
  planRatiosWrite,
  isPlanWorthWriting,
} from "@usemoney/core/market-data";
// MONEY-1401 F10 — the SAME recency bound the writer applies, imported rather
// than restated. A second copy of a threshold that decides what gets written is
// how the gate and the writer come to describe different populations, which is
// the whole of F8 one layer down.
import { annualRecencyVerdict } from "../../workers/src/processors/xbrl-ratios-logic";
// MONEY-1401 F4 — the ONE guard that decides whether `XbrlFiling.facts` is
// readable, imported rather than re-spelled. This file carried three hand-rolled
// `facts === null || typeof facts !== "object"` copies, and all three were the
// WEAKER rule: they admit `{}`, whose `.values` is `undefined`, so the identity
// rung's `(facts as XbrlFinancials).values.totalLiabilities` TypeErrors and the
// whole run dies at the top-level catch with NO verdict — from ONE malformed
// row, on a gate that cannot be re-run once armed.
import { readFacts } from "../../workers/src/processors/xbrl-projection-writer";
// MONEY-1401 F8 — the writer-reachable POLICY. Not re-spelled here for the same
// reason: it lived inline in this script as `inst.exchange === f.exchange`,
// where deleting it restored the 92.3% over-count with the suite fully green.
// Imported by PATH rather than from `@usemoney/core/market-data` because that
// barrel has no entry for it yet; the barrel export is the tidier home once
// someone owns that file.
import { writerReachableSymbols } from "../../packages/core/src/market-data/xbrl-ratios-gate";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

/**
 * ONE clock for the whole run — MONEY-1401 F10. The recency bound is applied in
 * a loop; reading `new Date()` per iteration would let two symbols be judged
 * against two different "now"s, which is invisible until a run straddles a day
 * boundary at exactly the bound.
 */
const RUN_NOW = new Date();

const VERBOSE = argv.includes("--verbose");
const LIMIT = Number(arg("limit") ?? 0) || 0;
const SYMBOLS = (arg("symbols") ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * The gate the spec names: >= 95% of non-bank ratios within 5% RELATIVE or
 * 0.5pp ABSOLUTE (MONEY-1250 added the second arm — see `judge`).
 *
 * The THRESHOLDS and the LADDER now live in `@usemoney/core/market-data`
 * (`xbrl-ratios-gate.ts`), pure and unit-tested, beside
 * `judgeSwitchoverReadiness`. These aliases exist only so the messages printed
 * below can quote the numbers; a second declaration would be a second source of
 * truth for a one-way-door decision. MONEY-1235.
 */
const PASS_RATE = RATIO_PASS_RATE;
const TOLERANCE = 0.05;
/** Below this many comparable pairs the run cannot conclude anything. */
const MIN_COMPARABLE = RATIO_MIN_COMPARABLE;

/**
 * How far BELOW the vendor's window an aligned filing may sit — MONEY-1250.
 *
 * 400 days: one fiscal year plus slack for a 53-week year or a late filing,
 * matching the span rule the rest of this subsystem uses. Anything older is a
 * DIFFERENT fiscal year and is counted as a coverage gap rather than graded.
 *
 * Deliberately generous. Too tight discards comparable pairs; too loose lets a
 * two-year-stale filing be graded, which is the defect this closes.
 */
const VENDOR_WINDOW_FLOOR_DAYS = 400;

/**
 * Absolute agreement floor, in PERCENTAGE POINTS — MONEY-1250.
 *
 * ONLY VALID FOR PERCENTAGE-VALUED RATIOS. This docstring used to open "every
 * ratio this gate judges is percentage-valued", and that was false: `debtToEquity`
 * is a BARE RATIO, where 0.5 is not half a percentage point but half the whole
 * quantity. It is what made 15 of 21 debtToEquity pairs read MATCH, including
 * AEGISVOPAK 0.479 against 0.844 and ACC 0.000 against 0.021.
 *
 * That is moot for `debtToEquity` itself, which is no longer graded — but a
 * constant whose correctness depends on a property of the ratio list, asserted
 * only in prose, is a trap for whoever adds the next ratio. So the property is
 * now declared per ratio in {@link PERCENTAGE_VALUED} and the floor is applied
 * only to members of it; a bare ratio gets the relative test alone.
 *
 * 0.5 rather than 0.25 because it is the
 * point at which the measured near-zero cluster resolves (13 rows within 0.5pp,
 * 7 more between 0.25 and 0.5) while a 10x scale error on the smallest
 * meaningful ratio still exceeds it — and the SCALE check runs first regardless.
 */
const ABSOLUTE_TOLERANCE_PP = 0.5;
const VENDOR_FLOOR = RATIO_VENDOR_FLOOR;

/**
 * Ratios comparable between a derived annual filing and a TTM snapshot.
 *
 * `debtToEquity` is a BALANCE-SHEET ratio — a point-in-time stock on both sides
 * — so it is comparable regardless of the period question. The margins and
 * returns are FLOW ratios and are only comparable when the filing is annual,
 * which is enforced above.
 */
const RATIOS = [
  "netMargin",
  "operatingMargin",
  "roe",
  "roa",
  "debtToEquity",
  // MONEY-1288 — `roce` added, and the reason is the shape of the PASS without
  // it. Measured on prod 2026-08-31, vendor rows available to grade against:
  //
  //   roe             2,038   graded
  //   netMargin          86   graded  (below VENDOR_FLOOR -> UNVERIFIABLE)
  //   roa                85   graded  (below floor -> UNVERIFIABLE)
  //   debtToEquity       86   graded  (DECLARED_DIVERGENCE, Ind-AS 116)
  //   operatingMargin     0   graded  -- against a column the vendor does not have
  //   roce            2,118   NOT graded
  //
  // So the verdict rested on `roe` ALONE while the writer ships 26 owned
  // columns, and the one other column with comparable coverage sat outside the
  // list. A gate must grade what the WRITER writes.
  //
  // `roce` and not the valuation ratios (`pe` 2,122, `marketCap` 2,122,
  // `pb` 2,117) because those are PRICE-dependent: our derived value and the
  // vendor's snapshot are struck on different dates, so a disagreement measures
  // the calendar, not the arithmetic. They need the price-date alignment rule
  // MONEY-1288 describes, and adding them without it would manufacture a red
  // line that means nothing. `roce` is computed from the filing alone and is
  // already in `PERIOD_DEPENDENT_COLUMNS` beside `roe`/`roa`, so the annual-only
  // rule enforced above already covers it.
  "roce",
] as const;
type RatioKey = (typeof RATIOS)[number];

/**
 * Which ratios are expressed in PERCENT — MONEY-1250.
 *
 * Gates {@link ABSOLUTE_TOLERANCE_PP}, whose units are percentage points and
 * which is meaningless on a bare ratio. Declared per key rather than inferred
 * from the name, and every member of `RATIOS` must appear here or in
 * {@link BARE_RATIO} — the exhaustiveness check below fails the run otherwise,
 * so adding a ratio forces the decision instead of inheriting one.
 */
const PERCENTAGE_VALUED = new Set<RatioKey>([
  "netMargin",
  "operatingMargin",
  "roe",
  "roa",
  "roce",
]);
/** Ratios that are a plain multiple, where an absolute pp floor does not apply. */
const BARE_RATIO = new Set<RatioKey>(["debtToEquity"]);
for (const k of RATIOS) {
  if (PERCENTAGE_VALUED.has(k) === BARE_RATIO.has(k)) {
    throw new Error(
      `ratio "${k}" must be declared in exactly one of PERCENTAGE_VALUED or ` +
        `BARE_RATIO — the absolute tolerance floor is in percentage points and ` +
        `silently means something else on a bare ratio (MONEY-1250)`,
    );
  }
}

/**
 * Ratios whose two sides are DIFFERENT QUANTITIES — MONEY-1250.
 *
 * Not a tolerance, not a skip, and not a way to make a red line go green: a
 * declared ratio grades `DECLARED_DIVERGENCE`, which counts as neither a pass
 * nor a block and is named separately in the verdict so it can never be read as
 * agreement. The string is printed verbatim, because a declaration whose
 * evidence lives only in a commit message is indistinguishable from a
 * suppression six months later.
 *
 * The bar for entering this map is deliberately high: the difference must be
 * DEFINITIONAL, MEASURED, and — the part that matters most — **impossible to
 * close from the documents we hold**. A gap we could close by parsing more of
 * the filing is a coverage gap, and the rule for those is to fix them, not to
 * declare them. See the `totalCash` note at the foot of this block for a
 * divergence that was investigated in this same ticket and deliberately NOT
 * declared for exactly that reason.
 */
const DECLARED_DIVERGENCES: Partial<Record<RatioKey, string>> = {
  /**
   * ## The finding, and its direction
   *
   * OUR `totalDebt` is `borrowingsCurrent + borrowingsNonCurrent` and nothing
   * else (`projectFinancials`, xbrl-projection.ts — `genericDebt`). The
   * INCUMBENT's debt additionally contains Ind-AS 116 LEASE LIABILITIES.
   *
   * The direction is worth stating explicitly because the intuitive version of
   * this hypothesis runs the other way ("we sum the filing's components, so we
   * over-count; the vendor excludes leases"). It is the OPPOSITE, and the data
   * says so unambiguously: of the 1,398 disagreeing `totalDebt` pairs in the
   * financials reconcile, **1,307 (93.5%) have THEIRS greater than OURS**, and
   * only 91 the reverse. A near-one-way direction over 1,398 pairs is the
   * signature of a missing additive term, not of scatter.
   *
   * ## Why leases specifically, rather than "some extra liabilities"
   *
   * Three independent lines, measured on prod 2026-08-23/24:
   *
   *  1. THE ZERO-BORROWINGS SET. 267 pairs have our `totalDebt` EXACTLY 0 —
   *     the filing itself reports `BorrowingsCurrent` and `BorrowingsNoncurrent`
   *     both zero — while the incumbent still assigns them debt. They are the
   *     famously debt-free, lease-heavy names: TCS Rs 9,392 Cr, PETRONET 2,657,
   *     BATAINDIA 1,446, MEDPLUS 1,120, MPHASIS 1,116, LTTS 578, GOCOLORS 507,
   *     ACC 430. On 23 of 29 sampled, the incumbent's whole figure falls inside
   *     the band the lease liability must occupy in the filing's own structure
   *     — between `OtherNoncurrentFinancialLiabilities` and that plus its
   *     current sibling. TCS: 0 borrowings, incumbent 9,392, non-current other
   *     financial liabilities 8,518.
   *
   *  2. A THIRD SOURCE. screener.in reproduces the incumbent's debt to within
   *     0.5% on 12 of 20 comparable ratio pairs — BATAINDIA 1,387 vs 1,386.6,
   *     ABLBL 3,018 vs 3,016.3, AEGISVOPAK 3,731 vs 3,730.9, ASIANPAINT 3,929
   *     vs 3,928.9. Our borrowings-only figure reproduces it on 1 of 20, and
   *     that one (ASHOKLEY) is a case where the two definitions coincide.
   *
   *  3. THE IND-AS 116 STEP. The standard capitalises leases for annual periods
   *     beginning on/after 1 Apr 2019, so Mar-2020 is the first affected balance
   *     sheet. BATAINDIA's screener `Borrowings` series is 0, 0, 0, 0, 0 through
   *     Mar-2019 and 1,249 at Mar-2020 — with `Fixed Assets` jumping 317 -> 1,369
   *     in the same year, which is the right-of-use asset, the other half of the
   *     same entry. Bata borrowed nothing. TCS shows the same step, 62 -> 8,174,
   *     51x its own median year-on-year move.
   *
   * ## Why this is DECLARED rather than fixed
   *
   * Because the number is not in the document. Checked across all 11,296
   * annual filings we hold and 8 raw instances fetched from NSE: the integrated
   * filing taxonomy's ONLY lease element is
   * `PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities` — a CASH-FLOW
   * item. There is no lease-liability BALANCE element at all, and our canonical
   * concept set therefore has no key matching /lease/i.
   *
   * `OtherNoncurrentFinancialLiabilities` is the closest thing available and is
   * NOT the lease liability: it also carries security deposits, capital
   * creditors and derivative liabilities. Backing leases out of it would be
   * inventing a component to make a gate agree — the compensating move this
   * repo has repeatedly chosen not to make. So the honest position is that our
   * figure means "borrowings", the vendor's means "borrowings plus leases",
   * both are defensible, and no tolerance closes the distance between them.
   *
   * ## The residue, stated rather than absorbed
   *
   * Leases are the dominant mechanism, not the only one. 91 of the 1,398
   * disagreements run the other way and this does not explain them; and 7 of
   * the 20 comparable `debtToEquity` pairs turned out to be a STALE VENDOR
   * PERIOD rather than a definition — their incumbent reproduces exactly from
   * the PRIOR fiscal year (AEQUS 0.1%, BEML 0.1%, BALRAMCHIN 0.0%, ACUTAAS
   * 1.3%, ASHAPURMIN 1.6%, BALUFORGE 0.5%, BLUESTONE 4.8%), because
   * `fetchedAt` is recent even when the CONTENT is a year old, which the
   * window ceiling and floor cannot detect. Not grading the ratio makes both
   * moot here; neither is claimed to be fixed.
   */
  debtToEquity:
    `our totalDebt is borrowings only (borrowingsCurrent + borrowingsNonCurrent), ` +
    `while the incumbent's includes Ind-AS 116 LEASE LIABILITIES — measured: ` +
    `1,307 of 1,398 disagreeing totalDebt pairs (93.5%) run theirs > ours, 267 ` +
    `of them where our borrowings are EXACTLY zero (TCS, BATAINDIA, MPHASIS, ` +
    `LTTS); screener.in reproduces the incumbent to <0.5% on 12 of 20 pairs ` +
    `against 1 of 20 for ours; and BATAINDIA's borrowings step 0 -> 1,249 Cr at ` +
    `Mar-2020, the Ind-AS 116 adoption year, with no borrowing event. The ` +
    `integrated-filing taxonomy publishes NO lease-liability balance element ` +
    `(only the cash-flow PaymentsOfLeaseLiabilities), so this gap cannot be ` +
    `closed from the filings — it is a definition difference, not an error on ` +
    `either side`,

  // NOT DECLARED, deliberately — `totalCash` / the vendor's liquid-assets
  // column. MONEY-1250 measured it in the same pass and it looks superficially
  // like the case above: 2,469 of 2,484 disagreements (99.4%) run theirs >
  // ours, median ours/theirs 0.267. The definition is
  // `CashAndCashEquivalents + BankBalanceOtherThanCashAndCashEquivalents +
  // CurrentInvestments`, which reproduces the incumbent on 28 of 29 sampled
  // filings (RELIANCE 106,502 -> 225,211; WIPRO 12,197 -> 53,345; TCS 8,342 ->
  // 46,152, all exact) against 0 of 29 for cash-and-equivalents alone.
  //
  // It is NOT declared because BOTH missing terms ARE in the filing, on the
  // same balance sheet, in the same context — we simply do not map them
  // (`CONCEPTS` in xbrl-financials-logic.ts has `cashAndCashEquivalents` and
  // neither of the other two). That makes it a PARSER COVERAGE GAP, and the
  // rule for those is to close them, not to declare them. Declaring it would
  // be documenting a gap we can fix. It needs its own ticket: adding two
  // concepts changes what `totalCash` MEANS for every reader, which is a
  // writer decision, not a gate decision.
};

/**
 * Symbols removed from the comparison population entirely — MONEY-1255 (D3).
 *
 * ## READ THIS BEFORE ADDING ONE
 *
 * DIFFERENT IN KIND from {@link DECLARED_DIVERGENCES} above, and the difference
 * is what decides which instrument a finding belongs in:
 *
 *   A DECLARATION is per RATIO. It says "these two sides are different
 *   quantities on EVERY symbol", grades `DECLARED_DIVERGENCE`, and removes the
 *   whole ratio from the verdict. It is the right shape for `debtToEquity`,
 *   where the gap is in the definition and is universal.
 *
 *   AN EXCLUSION is per SYMBOL. It says "this ratio is graded normally, and we
 *   are choosing not to grade THESE rows". It removes nothing definitional and
 *   buys no understanding — it agrees to arm over a population already found to
 *   be wrong.
 *
 * Declaring `roe` would have been the wrong instrument by a wide margin here.
 * `roe` is the ONLY ratio with real vendor coverage (2,038 of 2,135 rows on
 * prod 2026-08-21, against 0 / 86 / 85 / 86 for the other four), so declaring it
 * would take the one graded ratio out of the verdict and leave the gate passing
 * on four UNVERIFIABLE lines — the same shape MONEY-1237's self-comparison trap
 * produced, reached from the other direction.
 *
 * The mechanics that keep this from becoming a way to delete red lines are the
 * ones its sibling in `xbrl-reconcile.ts` uses, and they are not optional:
 *
 *  1. Every symbol here gets a PRINTED row saying exactly what it removed —
 *     INCLUDING the ones that removed nothing, which is the row a reader needs
 *     most (`tallySymbolExclusions` seeds from this list, not from the rows) —
 *     followed by a warning naming the two readings of a zero, both of which
 *     mean the entry is wrong rather than the data being clean.
 *  2. The block prints BEFORE the per-ratio ladder it alters, because a
 *     disclosure that arrives after the verdict is a footnote to a decision
 *     already taken.
 *
 * ## The two, and where they came from
 *
 * Both were originally declared in `xbrl-reconcile.ts` on a founder
 * instruction that assumed one shared exclusion set across the two gates. They
 * removed NOTHING there — neither contributes a scale or sign row to the
 * financials ladder and neither appears in its output at all — and its
 * zero-row rule is what surfaced that. Their blocking verdicts are here.
 */
const EXCLUDED_SYMBOLS: Readonly<Record<string, string>> = {
  CENTUM:
    `roe SIGN_MISMATCH, xbrl=-0.652 vs tickertape=+0.833 — one of the exactly ` +
    `2 sign mismatches that leave this gate BLOCKED on roe. The mechanism is ` +
    `the attributable-vs-profitForPeriod ambiguity documented at ` +
    `xbrl-projection.ts:1069, which decides the sign of every return ratio: ` +
    `CENTUM FY2024 CONSOLIDATED tags ProfitOrLossAttributableToOwnersOfParent ` +
    `at +4.098 Cr against a profitForPeriod of -2.755 Cr — OPPOSITE SIGNS, so ` +
    `whichever line \`netIncome\` takes flips roe's sign outright. That is a ` +
    `filing-side ambiguity we have chosen not to resolve, not a computation ` +
    `error, and it is NOT a definitional gap the way debtToEquity is — which ` +
    `is why it is excluded rather than declared. ` +
    // RE-VERIFIED AGAINST THE FILINGS — MONEY-1401, prod 2026-09-13. An
    // exclusion whose evidence is only a sentence is indistinguishable from a
    // way of deleting a red line, so the entry names the row a reader can
    // re-query.
    `VERIFIED prod 2026-09-13: XbrlFiling CENTUM 2024-03-31 CONSOLIDATED tags ` +
    `profitForPeriod -2.755 Cr, profitAttributableToOwners +4.098 Cr and NCI ` +
    `-4.618 Cr — and those three do NOT reconcile (+4.098 + -4.618 = -0.520, ` +
    `not -2.755), so the FILING cannot say which line is net income. The ` +
    `exclusion is justified by the document, not by the verdict it removes`,
  DVL:
    `roe SIGN_MISMATCH, xbrl=-1.151 vs tickertape=+4.684 — the other of the 2 ` +
    `blocking this gate on roe. Same attributable/NCI shape as CENTUM. Note ` +
    `the magnitudes are not near-reciprocal here (4.684 is 4x |ours|), so ` +
    `unlike the financials gate's MODIRUBBER/OPTIEMUS pair this is not the ` +
    `vendor carrying a loss as a positive number — it is a different number ` +
    `AND a different sign, which is why nothing about it is translatable. ` +
    `VERIFIED prod 2026-09-13: XbrlFiling DVL 2025-03-31 CONSOLIDATED — the ` +
    `year inside the vendor's 2026-03-21 window — tags profitForPeriod ` +
    `-20.046 Cr with profitAttributableToOwners 0 AND NCI 0. An attributable ` +
    `line of exactly zero against a real 20-crore loss is the same ambiguity ` +
    `in its degenerate form: the owners' share is not stated at all, so which ` +
    `line \`netIncome\` takes decides the sign. Justified by the document`,
};

/**
 * The exclusion list as a lookup, built once. Symbols are upper-cased on both
 * sides so a lower-case entry cannot silently exclude nothing.
 */
const EXCLUDED_SYMBOL_SET: ReadonlySet<string> = new Set(
  Object.keys(EXCLUDED_SYMBOLS).map((s) => s.toUpperCase()),
);

type Outcome =
  | "MATCH"
  | "DISAGREEMENT"
  | "SCALE_MISMATCH"
  | "SIGN_MISMATCH"
  | "INCOMPARABLE";

interface Judgement {
  symbol: string;
  ratio: RatioKey;
  outcome: Outcome;
  derived: number | null;
  incumbent: number | null;
  relDiff: number | null;
  /**
   * The incumbent row was ALREADY stamped {@link XBRL_SOURCE} — this pair holds
   * XBRL against itself and is not evidence about anything. MONEY-1237.
   */
  selfComparison: boolean;
  /**
   * This symbol's annual winner sits on an instrument the RATIOS WRITER can
   * actually reach — MONEY-1401 F8b. See {@link writerReachableSymbols}.
   *
   * The agreement rungs grade every pair regardless, because a scale or sign
   * error is a statement about the DERIVATION CODE and the code is the same for
   * every symbol. This tag exists so the pairs arming would ACTUALLY STORE can
   * be rated SEPARATELY: on prod 2026-09-13 they are 7.7% of the graded set, so
   * a disagreement confined to them is invisible in the headline rate.
   */
  writable: boolean;
}

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-ratios]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-ratios]", ...a),
};

/**
 * Classify one pair.
 *
 * Order matters and mirrors `xbrl-reconcile`'s ladder. SCALE and SIGN are
 * separated from plain disagreement because both are SYSTEMATIC: one occurrence
 * implies a whole class is wrong, so they must not be diluted into a rate that
 * a few hundred matches can carry over the line.
 */
function judge(
  derived: number | null,
  incumbent: number | null,
  ratioKey: RatioKey,
): {
  outcome: Outcome;
  relDiff: number | null;
} {
  if (
    derived === null ||
    incumbent === null ||
    !Number.isFinite(derived) ||
    !Number.isFinite(incumbent)
  ) {
    // NOT a disagreement — but it still counts toward the population, so a
    // source that mostly has nothing cannot pass on the handful it does have.
    return { outcome: "INCOMPARABLE", relDiff: null };
  }
  if (derived === 0 && incumbent === 0) return { outcome: "MATCH", relDiff: 0 };

  if (
    Math.sign(derived) !== Math.sign(incumbent) &&
    derived !== 0 &&
    incumbent !== 0
  ) {
    return { outcome: "SIGN_MISMATCH", relDiff: null };
  }

  const denom = Math.abs(incumbent);
  if (denom === 0) return { outcome: "INCOMPARABLE", relDiff: null };
  const relDiff = Math.abs(derived - incumbent) / denom;

  // A power-of-ten error is a UNITS bug, not a rounding difference. Checked
  // before the tolerance so a 10x miss can never be reported as a mere
  // disagreement.
  const ratio = Math.abs(derived) / denom;
  for (const p of [10, 100, 1000, 0.1, 0.01, 0.001]) {
    if (Math.abs(ratio - p) / p < 0.02) {
      return { outcome: "SCALE_MISMATCH", relDiff };
    }
  }

  // ABSOLUTE FLOOR, applied only AFTER the scale check above — MONEY-1250.
  //
  // ## Why a percentage-valued metric needs one
  //
  // Every ratio here is already expressed in PERCENTAGE POINTS, and a RELATIVE
  // tolerance on such a metric is structurally hostile near zero: a company with
  // a 0.05% ROE fails a 5% relative test on a 0.0025pp difference, which is
  // below the rounding either side publishes. Measured on prod: 13 of the 53
  // residual roe disagreements sit within 0.5pp ABSOLUTE — EXXARO at 0.00pp,
  // BPL and ADL at 0.01pp, MIRZAINT 0.04pp, ARENTERP 0.07pp.
  //
  // ## Why this is not "widening the tolerance"
  //
  // The header warns against loosening, and it is right about the RELATIVE band:
  // raising 5% to 10% would absorb real errors proportionally across the whole
  // range. An absolute floor does the opposite — it is inert everywhere the
  // relative test is meaningful and only engages where the denominator is too
  // small for a ratio to be informative. At a 20% ROE, 0.5pp IS 2.5% relative,
  // so the floor never overrides the relative test on a normal-sized value.
  //
  // ## The ordering is load-bearing
  //
  // AFTER the scale check, deliberately. A 10x error on a 0.05% ROE is 0.45pp
  // and would be absorbed by this floor if it ran first — a UNITS bug reported
  // as a match. There are zero such rows today; the ordering is what keeps it
  // that way.
  const absDiff = Math.abs(derived - incumbent);
  // Percentage-valued ratios ONLY — MONEY-1250. On a bare ratio like
  // `debtToEquity`, 0.5 is half the entire quantity rather than half a
  // percentage point, and the floor would swallow AEGISVOPAK's 0.479 vs 0.844
  // as a MATCH. A bare ratio gets the relative test alone.
  const withinAbsoluteFloor =
    PERCENTAGE_VALUED.has(ratioKey) && absDiff <= ABSOLUTE_TOLERANCE_PP;

  return {
    outcome:
      relDiff <= TOLERANCE || withinAbsoluteFloor ? "MATCH" : "DISAGREEMENT",
    relDiff,
  };
}

async function main(): Promise<void> {
  log.info("READ-ONLY ratios validation — nothing will be written");
  log.info(
    `gate: >= ${(PASS_RATE * 100).toFixed(0)}% of non-bank ratios within ` +
      `${(TOLERANCE * 100).toFixed(0)}% RELATIVE or ${ABSOLUTE_TOLERANCE_PP}pp ` +
      `ABSOLUTE (percentage-valued ratios ONLY — ` +
      `${[...PERCENTAGE_VALUED].join(", ")}; a bare ratio like ` +
      `${[...BARE_RATIO].join(", ")} gets the relative test alone, because ` +
      `0.5 there is half the whole quantity), so a relative-only test ` +
      `fails a 0.05% ROE on a 0.0025pp difference; the absolute arm is inert ` +
      `above ~10% and runs AFTER the scale check so a 10x units bug cannot hide ` +
      `in it. ANNUAL filings only; floors — ` +
      `${MIN_COMPARABLE} comparable pair(s), ${VENDOR_FLOOR} vendor row(s). ` +
      `Pairs whose incumbent is already ${XBRL_SOURCE} are EXCLUDED from every ` +
      `rate and fail the run outright (MONEY-1237).`,
  );
  const declaredKeys = RATIOS.filter(
    (k) => DECLARED_DIVERGENCES[k] !== undefined,
  );
  if (declaredKeys.length > 0) {
    log.info(
      `declared definitional divergence(s), NOT GRADED by this run: ` +
        `${declaredKeys.join(", ")}. These are not failures and not passes — ` +
        `our figure and the incumbent's are different quantities, so the run ` +
        `makes no claim about them. Each one's evidence is printed with its ` +
        `verdict below.`,
    );
  }

  const filings = await prisma.xbrlFiling.findMany({
    where: {
      periodType: "ANNUAL",
      // A cumulative roll-up sharing a periodEnd with a discrete period is a
      // DIFFERENT fact; including both would compare one symbol twice against
      // one snapshot.
      cumulative: false,
      ...(SYMBOLS.length ? { symbol: { in: SYMBOLS } } : {}),
    },
    // Symbol-major matters twice over. It is what lets the grouping below see a
    // symbol's siblings together, and it bounds the damage `take` can do: a
    // truncated page can only cut INSIDE one symbol, so at worst the boundary
    // symbol is judged on the sibling that survived the cut.
    orderBy: [{ symbol: "asc" }, { periodEnd: "desc" }],
    // `LIMIT` counts ROWS, and this population has a ~2x duplication factor —
    // 1,486 of 2,108 symbols carry two filings for their newest year — so
    // `--limit=200` judges roughly 100 symbols, not 200. That is the MONEY-1207
    // rule (a `take` counted in rows over a table where one logical unit
    // occupies several silently returns fewer distinct units than asked for).
    // Left as-is because this flag is a SPOT-CHECK affordance and the gate run
    // passes no limit at all — but the arithmetic is written down here so the
    // next person reading a small sample knows what they actually sampled.
    ...(LIMIT ? { take: LIMIT } : {}),
    select: {
      symbol: true,
      exchange: true,
      // MONEY-1401 F8 — WHICH instrument this filing resolves to. The FILL
      // census asks whether the writer would ever write this symbol, and the
      // writer's eligibility (`XBRL_ARM_WHERE`) is a relation on THIS id, not a
      // (symbol, exchange) match: a symbol can hold both an NSE and a BSE
      // instrument row while its filings point at only one of them.
      instrumentId: true,
      periodEnd: true,
      basis: true,
      filerKind: true,
      facts: true,
      coverage: true,
      // Read ONLY by `selectFilingForPeriod` — MONEY-1233. Its tie-break runs
      // basis -> coverage -> filedAt -> sourceUrl and is documented as needing
      // to be a TOTAL order so the winner is a function of the candidate SET.
      // Fetch a prefix of that chain and ties fall back to query order, which
      // is the very thing being fixed here.
      filedAt: true,
      sourceUrl: true,
    },
  });

  if (filings.length === 0) {
    log.warn(
      "no ANNUAL, non-cumulative XbrlFiling rows matched. That is NOT a pass — " +
        "there is nothing to judge. Check the P10 backfill coverage first.",
    );
    process.exitCode = 1;
    return;
  }

  // Newest annual PERIOD per symbol, then the sibling the WRITER would pick —
  // MONEY-1233, the ratios twin of MONEY-1232.
  //
  // THE DEFECT this replaces was `if (!newest.has(f.symbol))` over an
  // `orderBy: [symbol asc, periodEnd desc]` read, described as "first wins".
  // The cardinality was right — one filing per symbol — but the CHOICE was not.
  // A company files both CONSOLIDATED and STANDALONE for the same period, and
  // those two rows have EQUAL sort keys under that ordering, so "first" is
  // whichever Mongo happened to return.
  //
  // Measured on prod 2026-08-20 over ANNUAL + cumulative:false — of 2,108
  // symbols judged, 1,486 (70.5%) had two filings on their newest year. The two
  // are not close: AMBUJACEM FY2022 revenue is 13,964.95 standalone against
  // 28,965.46 consolidated.
  //
  // Why this matters MORE here than in the financials reconcile: `StockRatios`
  // is @@unique([symbol, exchange]) with NO period dimension, so one row IS the
  // symbol's entire ratio set. A mis-picked sibling does not corrupt one period
  // of a history, it replaces everything — and `selectFilingForPeriod`'s own
  // docstring warns the choice "flips with whatever order the query happened to
  // return, so the row can oscillate between two different truths on alternate
  // nights and no run ever looks wrong".
  //
  // The author was already reasoning about this bug class: the `cumulative:
  // false` filter above carries a comment about not "comparing one symbol twice
  // against one snapshot". That caught the `cumulative` dimension of
  // `XbrlFiling`'s key and missed the `basis` one.
  //
  // The max is computed explicitly rather than leaned on from `orderBy`, so the
  // result no longer depends on the query's ordering at all.
  const bySymbol = new Map<string, (typeof filings)[number][]>();
  for (const f of filings) {
    const g = bySymbol.get(f.symbol);
    if (g) g.push(f);
    else bySymbol.set(f.symbol, [f]);
  }

  /**
   * Our filing for a symbol, optionally bounded by the vendor's own window.
   *
   * `maxPeriodEnd` is what MONEY-1250 added. Without it this picked the NEWEST
   * annual unconditionally and compared it to a vendor row frozen at a
   * different year — see `vendorComparablePeriodEnd` for the measurement. With
   * it, a symbol whose newest filing post-dates the vendor's snapshot is
   * compared on the year the vendor could actually have seen.
   */
  const pickWinner = (
    rows: (typeof filings)[number][],
    maxPeriodEnd?: Date,
  ): (typeof filings)[number] | undefined => {
    const eligible =
      maxPeriodEnd === undefined
        ? rows
        : rows.filter((r) => r.periodEnd <= maxPeriodEnd);
    if (eligible.length === 0) return undefined;
    const latest = eligible.reduce((a, b) =>
      b.periodEnd > a.periodEnd ? b : a,
    ).periodEnd;
    const sameYear = eligible.filter(
      (r) => r.periodEnd.getTime() === latest.getTime(),
    );
    // `selectFilingForPeriod` returns null for "no winner"; this helper's
    // contract is `undefined`, and collapsing the two here keeps every call
    // site on one absence value.
    return selectFilingForPeriod(sameYear) ?? undefined;
  };

  // UNBOUNDED pass, kept only to size the candidate set for the incumbent read
  // below — the BOUNDED winner is chosen once the vendor's date is in hand.
  const newest = new Map<string, (typeof filings)[number]>();
  let ambiguous = 0;
  for (const [symbol, rows] of bySymbol) {
    const latest = rows.reduce((a, b) =>
      b.periodEnd > a.periodEnd ? b : a,
    ).periodEnd;
    if (
      rows.filter((r) => r.periodEnd.getTime() === latest.getTime()).length > 1
    )
      ambiguous++;
    const winner = pickWinner(rows);
    if (winner) newest.set(symbol, winner);
  }

  log.info(
    `judging ${newest.size} symbol(s)` +
      (ambiguous > 0
        ? ` — ${ambiguous} had sibling filings on their newest year, resolved ` +
          `by selectFilingForPeriod (CONSOLIDATED beats STANDALONE), matching ` +
          `what xbrl-projection-writer would persist`
        : ""),
  );

  const judgements: Judgement[] = [];
  let banksSkipped = 0;
  let noIncumbent = 0;
  /** Rows whose `facts` JSON is null or not an object — MONEY-1235. */
  let unreadableFacts = 0;
  /**
   * Incumbent ROWS already stamped {@link XBRL_SOURCE} — MONEY-1237.
   *
   * Counted per SYMBOL, unlike `xbrl-reconcile.ts`'s row-wise `xbrlIncumbents`:
   * `StockRatios` is @@unique([symbol, exchange]) with no period or statement
   * dimension, so one row IS the symbol's entire ratio set. Expected to be zero
   * — the ratios job has never been armed — and counted rather than assumed,
   * because a non-zero is the difference between a gate and a mirror.
   */
  let xbrlIncumbentRows = 0;
  /** Vendor rows with no `fetchedAt` — nothing to align to. MONEY-1250. */
  let undatedIncumbent = 0;
  /** We hold no annual filing inside the vendor's window. A coverage gap. */
  let outsideVendorWindow = 0;
  /** The window chose a DIFFERENT filing than "newest" would have. */
  let realignedToWindow = 0;
  /** Compared pairs whose roe/roa used a CLOSING denominator. */
  let closingBasisSkipped = 0;
  /**
   * The BALANCE-SHEET IDENTITY on the filing each graded symbol was judged on
   * — MONEY-1401. Keyed by symbol so the declared symbol exclusions can be
   * applied to this rung too, rather than it quietly grading a population two
   * rows wider than every rate below it.
   */
  const identityBySymbol = new Map<string, BalanceIdentityVerdict>();
  /**
   * Symbols where WE hold an annual filing and the vendor holds NO ROW — the
   * CANNOT-GRADE bucket. `noIncumbent` has always counted these; nothing ever
   * printed WHICH, so the largest company this gate is silent about was as
   * invisible as the smallest.
   */
  const cannotGradeSymbols: string[] = [];

  /**
   * Is this filing a LENDER? — MONEY-1250.
   *
   * ## `filerKind` cannot answer this and never could for a modern filing
   *
   * `xbrl-filing-index.ts` hardcodes `filerKind: "GENERIC"` for EVERY
   * integrated-era record — its own comment says the filer class "is resolved by
   * the document parser, not guessed here", and the parser's answer lands in
   * `facts.family`. So a `/BANK|NBFC|INSUR/` test against `filerKind` excludes
   * exactly ZERO modern-era lenders.
   *
   * Measured on prod 2026-08-23 over 18,384 ANNUAL filings: the `filerKind` test
   * catches 716, and **249 filings are a lender by `facts.family` and are missed
   * by it** — FEDERALBNK, BANDHANBNK, UJJIVANSFB, MASFIN among them. They were
   * being graded with industrial-company formulas: `debtToEquity` on a bank is
   * meaningless (deposits are not debt in that sense and are not in `borrowings`
   * at all), so those rows were counted as disagreements about arithmetic when
   * they were disagreements about what the company IS.
   *
   * `filerKind` is kept as a SECOND arm rather than replaced: it is the only
   * signal for legacy-era filings, whose entry point names the family and whose
   * `facts.family` may be absent.
   */
  function isLenderFiling(f: { filerKind: string; facts: unknown }): boolean {
    if (/BANK|NBFC|INSUR/i.test(f.filerKind)) return true;
    const family = (f.facts as { family?: unknown } | null)?.family;
    return typeof family === "string" && isLenderFamily(family as never);
  }

  // Incumbents loaded ONCE — MONEY-1234, matching what the financials gate now
  // does. This was a `findFirst` inside the loop below: ~2,100 sequential round
  // trips to Atlas. `StockRatios` is @@unique([symbol, exchange]) — one row per
  // symbol — so the whole comparison set is a handful of `findMany` calls and a
  // Map. The financials reconcile's version of this N+1 ran for 6h20m at 0.0%
  // CPU before being killed unfinished, and a gate that cannot be re-run in
  // minutes stops being re-run.
  // LENDERS INCLUDED — MONEY-1401 F8. The agreement ladder still skips them
  // (a bank's debt-to-equity is not comparable to an industrial's), but the
  // FILL census below does not: the WRITER writes lenders, so a lender column
  // arming would overwrite has to be counted or the census understates exactly
  // the population the gate was already silent about.
  const candidateSymbols = [...newest.values()].map((f) => f.symbol);
  const incumbents = new Map<string, Record<string, unknown>>();
  const RATIO_CHUNK = 200;
  for (let i = 0; i < candidateSymbols.length; i += RATIO_CHUNK) {
    const rows = await prisma.stockRatios.findMany({
      where: { symbol: { in: candidateSymbols.slice(i, i + RATIO_CHUNK) } },
      select: {
        symbol: true,
        exchange: true,
        source: true,
        // WHEN the vendor computed this row — MONEY-1250. The join below is
        // aligned to it; without the date there is nothing to align to.
        fetchedAt: true,
        // WHICH denominator OUR roe/roa used, once this row is ours. Compared
        // rows are filtered to AVERAGE, because the vendor uses average equity
        // and a CLOSING row is a different measurement, not a disagreement.
        returnBasis: true,
        // DERIVED FROM `RATIOS` — MONEY-1401, and the same fix the financials
        // gate already carries (`xbrl-reconcile.ts`, "DERIVED from FIELDS").
        //
        // This was a hardcoded list, and it is the more dangerous of the two
        // copies: a column missing from the SELECT comes back `undefined`, the
        // comparison reads that as "the vendor has no value here" and prints
        // "no vendor data at all". MONEY-1288 added "roce" to `RATIOS` and did
        // not widen the list, so the gate compared 1,704 derived values against
        // `undefined` over a column the vendor fills on 2,118 of 2,135 rows —
        // the best-covered column after `roe` — and read PASS for months on
        // what was really one graded ratio.
        //
        // A zero that means "we never asked" is indistinguishable in the report
        // from a zero that means "nothing to compare against", and the second is
        // the reading that would have justified arming. On this table the
        // mistake is UNRECOVERABLE: StockRatios is @@unique([symbol, exchange])
        // with no `source` in the key, so the first XBRL write destroys the
        // incumbent and no later run can re-derive the evidence.
        //
        // Spread rather than listed, so there is nothing left to drift. Pinned
        // by `xbrl-ratios-self-comparison-wiring.test.ts`.
        ...Object.fromEntries(RATIOS.map((r) => [r, true])),
      },
    });
    for (const r of rows)
      incumbents.set(
        `${r.symbol}\u0000${r.exchange}`,
        r as unknown as Record<string, unknown>,
      );
  }
  log.info(
    `loaded ${incumbents.size} incumbent ratio row(s) for ` +
      `${candidateSymbols.length} symbol(s) in ` +
      `${Math.ceil(candidateSymbols.length / RATIO_CHUNK)} quer(ies)`,
  );

  // ── WHO CAN THE WRITER ACTUALLY REACH? — MONEY-1401 F8/F8b ──────────────
  //
  // COMPUTED BEFORE THE GRADING LOOP, not after it. It used to sit 400 lines
  // below, inside the FILL census, which meant the only thing that could ask
  // "would arming ever write this row?" was the fill rung — every input to the
  // AGREEMENT ladder, the thing that actually sets READY/BLOCKED, was computed
  // over a population 92.3% of which the writer refuses.
  //
  // The grading loop is NOT filtered by this. A scale or sign mismatch is
  // evidence about the DERIVATION CODE, which is the same code for every
  // symbol, and today's reachable cohort is an accident of instrument
  // resolution that `scripts/data/reresolve-xbrl-instruments.ts` takes from
  // ~155 to ~2,000 — so dropping a blocker because it currently falls outside
  // arms the one-way door and then grows the cohort to include it. Each pair is
  // TAGGED instead, and rated a second time over the writable cohort alone.
  const instrumentIds = [
    ...new Set(
      [...newest.values()]
        .map((f) => f.instrumentId)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  const activeInstrumentsById = new Map<string, { exchange: string }>();
  const INSTRUMENT_CHUNK = 200;
  for (let i = 0; i < instrumentIds.length; i += INSTRUMENT_CHUNK) {
    const rows = await prisma.instrumentMapping.findMany({
      where: {
        id: { in: instrumentIds.slice(i, i + INSTRUMENT_CHUNK) },
        isActive: true,
      },
      select: { id: true, exchange: true },
    });
    for (const r of rows) activeInstrumentsById.set(r.id, r);
  }
  const writerReachable = writerReachableSymbols(
    newest.values(),
    activeInstrumentsById,
  );
  log.info(
    `writer-reachable: ${writerReachable.size} of ${newest.size} symbol(s) sit ` +
      `on an ACTIVE instrument of the filing's own exchange — the only rows ` +
      `arming would ever store`,
  );

  for (const f of newest.values()) {
    // ── THE RUNG THAT NEEDS NO VENDOR — MONEY-1401, AND IT RUNS FIRST ───────
    //
    // Placed at the TOP of the loop, ahead of every `continue` below it. It
    // used to sit after five of them — `!incumbent`, `undatedIncumbent`,
    // `outsideVendorWindow`, the window floor and the lender skip — so the one
    // rung advertised as surviving the vendor being dead had a population that
    // was exactly the VENDOR-GRADED set (1,736 symbols), and the 426-symbol
    // `cannotGrade` cohort it exists to reach was excluded by construction.
    //
    // The failure its own docstring names — "a parser that stopped emitting
    // `totalLiabilities` would score 100%" — would therefore have shown up as
    // `identityChecked: 0`, which produced `identityFailRate: undefined`,
    // `identityBlocked: false`, and a PASSING run.
    //
    // Lenders are IN. The agreement ladder excludes them because a bank's
    // debt-to-equity is not comparable to an industrial's; A = L + E is an
    // accounting identity that holds for every filer, and the WRITER writes
    // lenders, so grading them here is both sound and the honest population.
    //
    // Measured on the NEWEST annual (`f`), not on the vendor-aligned filing —
    // that is what `deriveOne` derives its balance sheet from, so it is the
    // filing an arming decision is about.
    // `readFacts`, not a local `typeof !== "object"` — MONEY-1401 F4. The local
    // rule ADMITS `{}`, whose `.values` is `undefined`, and the dereference two
    // lines down is `.values.totalLiabilities`. This rung runs FIRST, ahead of
    // every `continue` below it, for all ~2,025 symbols, and there is no
    // per-symbol `try` in this loop — so ONE malformed row TypeErrors into the
    // top-level catch and the run ends with NO VERDICT AT ALL. `readFacts` is
    // the writer's own guard and rejects an object with no `values`.
    const identityFacts = readFacts(f.facts);
    if (identityFacts === null) {
      // Not readable is not balanced. UNCHECKABLE is the third value and it is
      // never a pass — the same rule `checkBalanceIdentity` applies to a
      // missing leg, applied to a missing row.
      identityBySymbol.set(f.symbol, "UNCHECKABLE");
    } else {
      const identityProjected = projectFinancials(identityFacts);
      identityBySymbol.set(
        f.symbol,
        checkBalanceIdentity(
          identityProjected.balanceSheet?.totalAssets,
          // The FILED concept, never the projection's own
          // `totalAssets - totalEquity` fallback — fed that, the identity is
          // zero by construction and the check cannot fail.
          identityFacts.values.totalLiabilities,
          identityProjected.balanceSheet?.totalEquity,
        ),
      );
    }

    // Banks are excluded, not tolerated — see the header. `isLenderFiling`
    // rather than a `filerKind` regex: the latter matched no modern filing at
    // all (MONEY-1250).
    if (isLenderFiling(f)) {
      banksSkipped++;
      continue;
    }

    const incumbent = incumbents.get(`${f.symbol}\u0000${f.exchange}`) as
      | {
          source: string | null;
          fetchedAt: Date | null;
          returnBasis: string | null;
          netMargin: number | null;
          operatingMargin: number | null;
          roe: number | null;
          roa: number | null;
          debtToEquity: number | null;
        }
      | undefined;
    if (!incumbent) {
      // Nothing to compare against. Counted apart: a symbol Tickertape never
      // covered is coverage GAIN, not evidence about agreement.
      noIncumbent++;
      // NAMED, not only counted — MONEY-1401. Every rung below is silent about
      // these symbols by construction (no incumbent, so no pair, so no
      // `comparable` and no rate), and a count alone cannot tell an operator
      // whether the silence covers 400 microcaps or a dozen index names.
      cannotGradeSymbols.push(f.symbol);
      continue;
    }

    // ── ALIGN OUR FILING TO THE VENDOR'S WINDOW — MONEY-1250 ────────────────
    //
    // `StockRatios` carries no period, so the row states a ratio without saying
    // which year it is a ratio OF. This gate used to compare our NEWEST annual
    // to it regardless, and the vendor rows are a frozen snapshot: 1,794 of
    // 1,862 fetched 2026-03-21, against our newest ranging FY2020-FY2026.
    //
    // Measured, pinning every symbol to ONE year against the SAME vendor
    // values: FY2024 -> 22 sign mismatches / 10.8% match, FY2025 -> 1 / 40.2%,
    // FY2026 -> 90 / 9.1%. The sign COUNT is a function of the period chosen,
    // which is a join artifact, not a data defect — and this gate spent the
    // whole of MONEY-1237 #8 treating it as one.
    const window = vendorComparablePeriodEnd(incumbent.fetchedAt);
    if (window === undefined) {
      // The vendor row has no date, so nothing can be aligned to it. NOT a
      // disagreement, and deliberately NOT a fallback to "newest" — falling
      // back is exactly the behaviour being removed.
      undatedIncumbent++;
      continue;
    }
    const aligned = pickWinner(bySymbol.get(f.symbol) ?? [], window);
    if (!aligned) {
      // We hold no annual filing the vendor could have seen. A COVERAGE gap,
      // its own outcome — reporting it as DISAGREEMENT is how 59 of the 127
      // sign mismatches came to exist.
      outsideVendorWindow++;
      continue;
    }

    // ── AND A FLOOR, NOT ONLY A CEILING — MONEY-1250 ────────────────────────
    //
    // The window above is a CEILING: it stops us grading a filing NEWER than
    // the vendor could have seen. On its own it does nothing when our archive
    // holds no filing for the year the vendor IS describing — `pickWinner` then
    // returns the next-oldest annual and the gate grades FY2024 against a
    // vendor row about FY2025.
    //
    // That is a HOLE IN THE MIDDLE of the archive, not a tail: 13 of the 23
    // affected symbols hold FY2026 and FY2024 but not FY2025, so the ceiling
    // correctly rejects FY2026 and we silently fall back two years.
    //
    // Measured 2026-08-23, adding this floor:
    //
    //     roe        543/778 (69.8%) sign 25  ->  524/581 (90.2%) sign 2
    //     netMargin   27/68  (39.7%) sign  5  ->   21/24  (87.5%) sign 0
    //     roa / debtToEquity                  ->  sign 0
    //
    // Confirmed independently: for 22 of the 23, the vendor's roe reproduces
    // EXACTLY from the year we lack (KERNEX 38.12 = 50.23/((157.31+106.20)/2)).
    // So these are not disagreements at all — they are periods we cannot
    // compare, which is what `outsideVendorWindow` already means.
    const floor = new Date(
      window.getTime() - VENDOR_WINDOW_FLOOR_DAYS * 86_400_000,
    );
    if (aligned.periodEnd < floor) {
      outsideVendorWindow++;
      continue;
    }
    // `periodEnd` rather than `id`: the select does not carry `id`, and the
    // whole point of the realignment is the PERIOD, so comparing periods says
    // what happened more directly than comparing row identities would.
    if (aligned.periodEnd.getTime() !== f.periodEnd.getTime()) {
      realignedToWindow++;
    }

    // `f.facts` IS the parsed `XbrlFinancials` — MONEY-1234.
    //
    // THE DEFECT this replaces wrapped it again:
    //     deriveRatios({ values: (f.facts ?? {}) } as XbrlFinancials)
    // which produced `{ values: { taxonomy, family, …, values, coverage } }`.
    // Every concept lookup then read `values.revenueFromOperations` off an
    // object whose keys are `taxonomy`/`family`/`values`/… — so EVERY lookup
    // missed, EVERY ratio derived `undefined`, and the full-universe run scored
    // 1,861 of 1,861 symbols INCOMPARABLE on all five ratios.
    //
    // It printed as "TOO FEW COMPARABLE (< 50)", which reads as thin overlap
    // with the vendor — an entirely reasonable thing to shrug at. That is the
    // second time in this ticket a broken pipe hid behind a shruggable verdict
    // (the reconcile's statementType join was the first), which is why the
    // liveness guard below now exists.
    //
    // The wrap also dropped `family`, silently disabling `deriveRatios`'
    // bank/NBFC branch — so even a lucky lookup would have applied
    // industrial-company formulas to a lender's balance sheet.
    // MONEY-1235: guard the cast. `facts` is Prisma JSON, so a malformed or
    // null row used to TypeError the whole run to exit 1 — fail-closed, but it
    // reports a structural gate failure for what is one bad row. Count it.
    // ALIGNED, not `f` — MONEY-1250. `f` is the newest filing; `aligned` is the
    // one the vendor could have seen. Deriving from `f` after choosing
    // `aligned` would leave the join fix cosmetic.
    const facts = readFacts(aligned.facts);
    if (facts === null) {
      unreadableFacts++;
      continue;
    }

    // The ADJACENT PRIOR annual, so roe/roa derive on the AVERAGE denominator
    // the vendor uses — MONEY-1250. Without it every comparison here would be
    // CLOSING-based and skipped by the basis filter below, which would trade
    // one silent mismatch for another.
    const priorRows = (bySymbol.get(aligned.symbol) ?? []).filter(
      (r) => r.periodEnd < aligned.periodEnd,
    );
    const priorWinner =
      priorRows.length > 0
        ? pickWinner(priorRows, new Date(aligned.periodEnd.getTime() - 1))
        : undefined;
    const derived = deriveRatios(
      facts,
      readFacts(priorWinner?.facts) ?? undefined,
    );

    // COMPARE ONLY LIKE WITH LIKE — MONEY-1250. The vendor computes roe/roa on
    // AVERAGE equity (measured: closing reproduces it 45.3% of the time,
    // average 89.5%). A CLOSING-based row of ours is a DIFFERENT MEASUREMENT,
    // not a disagreement, so it is counted apart rather than graded.
    const closingBasis = derived.returnBasis === "CLOSING";
    if (closingBasis) closingBasisSkipped++;

    // THE READ THAT WAS MISSING — MONEY-1237. `source` was selected and typed
    // above and then never consulted, so a row we wrote ourselves was
    // indistinguishable from a vendor row for the entire life of this gate.
    const selfComparison = incumbent.source === XBRL_SOURCE;
    if (selfComparison) xbrlIncumbentRows++;

    for (const key of RATIOS) {
      // A CLOSING-basis roe/roa is not comparable to a vendor that uses
      // AVERAGE — MONEY-1250. Skipped for THOSE TWO ONLY: every other ratio in
      // the list is basis-independent, so voiding the whole symbol would throw
      // away good comparisons to avoid two bad ones.
      if (closingBasis && (key === "roe" || key === "roa")) continue;
      const d = (derived as Record<string, unknown>)[key];
      const i = (incumbent as Record<string, unknown>)[key];
      const { outcome, relDiff } = judge(
        typeof d === "number" ? d : null,
        typeof i === "number" ? i : null,
        key,
      );
      judgements.push({
        symbol: f.symbol,
        ratio: key,
        outcome,
        derived: typeof d === "number" ? d : null,
        incumbent: typeof i === "number" ? i : null,
        relDiff,
        selfComparison,
        // MONEY-1401 F8b — tagged, never filtered. See `Judgement.writable`.
        writable: writerReachable.has(f.symbol),
      });
    }
  }

  // ── report ──────────────────────────────────────────────────────────
  log.info("");
  log.info(`symbols with an annual filing : ${newest.size}`);
  log.info(`  banks/NBFC/insurers skipped : ${banksSkipped}`);
  log.info(`  unreadable facts            : ${unreadableFacts}`);
  log.info(
    `  no Tickertape row (coverage gain, not a disagreement): ${noIncumbent}`,
  );
  // THE JOIN, MEASURED — MONEY-1250. Every one of these was previously either
  // invisible or reported as a DISAGREEMENT.
  log.info(
    `  vendor-window alignment: ${realignedToWindow} symbol(s) compared on an ` +
      `EARLIER period than their newest (the vendor's snapshot cannot describe ` +
      `a year filed after it); ${outsideVendorWindow} had NO annual filing ` +
      `inside the window at all — a coverage gap, not a disagreement; ` +
      `${undatedIncumbent} vendor row(s) carry no fetchedAt so nothing could ` +
      `be aligned to them.`,
  );
  log.info(
    `  denominator basis: ${closingBasisSkipped} symbol(s) derived roe/roa on ` +
      `a CLOSING balance (no adjacent prior annual) and their roe/roa were ` +
      `NOT graded — the vendor uses AVERAGE equity, so a closing figure is a ` +
      `different measurement rather than a disagreement. Every other ratio for ` +
      `those symbols is still compared.`,
  );
  log.info(
    `  incumbents ALREADY stamped ${XBRL_SOURCE}: ${xbrlIncumbentRows}` +
      (xbrlIncumbentRows === 0 ? "  (clean — as expected)" : ""),
  );
  log.info("");

  // ── Has the projection already been armed here? — MONEY-1237 ────────
  //
  // Printed BEFORE the per-ratio ladder, at warn level, because it decides
  // whether any line below can be believed. Every one of those symbols
  // contributes up to five pairs that compare XBRL against itself; excluded
  // from the rates by `judgeRatioReadiness`, and named here so the reader knows
  // WHY the comparable counts are smaller than the population.
  if (xbrlIncumbentRows > 0) {
    log.warn("");
    log.warn(
      `${xbrlIncumbentRows} of the ${incumbents.size} incumbent row(s) loaded ` +
        `are ALREADY stamped ${XBRL_SOURCE}. XBRL_RATIOS_APPLY has been ` +
        `armed in this environment, so those rows are OUR OWN projection, not ` +
        `Tickertape's — StockRatios has no \`source\` in its unique key and keeps ` +
        `no history, so the vendor values this gate needs were overwritten and ` +
        `are gone. Every affected pair is excluded from both sides of every rate ` +
        `below, and the RUN fails regardless of the verdicts. Re-run against an ` +
        `environment where the projection has never been armed.`,
    );
    log.warn("");
  }

  // ── Liveness: did we DERIVE anything at all? — MONEY-1234 ───────────
  //
  // "Too few comparable" is a claim about the VENDOR's coverage. It is the
  // wrong claim when the truth is that our own derivation produced nothing,
  // and the two are indistinguishable in the per-ratio lines below because
  // both end up as INCOMPARABLE.
  //
  // That is exactly how the double-wrap above survived: 1,861 symbols, five
  // ratios, zero derived values, reported as thin overlap. A gate that cannot
  // tell "the vendor has no data" from "our pipe is severed" is not a gate.
  //
  // So: if we found incumbents to compare against but derived NOTHING across
  // every ratio, that is structural. Fail loudly and name the shape rather than
  // letting it read as a data-coverage problem.
  const derivedAny = judgements.some((j) => j.derived !== null);
  if (!derivedAny && judgements.length > 0) {
    log.warn("");
    log.warn(
      `STRUCTURAL FAILURE — ${judgements.length} comparison(s) attempted and ` +
        `NOT ONE derived a value. This is not thin vendor coverage; the ` +
        `derivation itself produced nothing. Check that \`deriveRatios\` is ` +
        `receiving the parsed XbrlFinancials (\`f.facts\`) and not a re-wrapped ` +
        `\`{ values: f.facts }\` — that mistake makes every concept lookup miss ` +
        `and reports as "TOO FEW COMPARABLE" (MONEY-1234).`,
    );
    // No `$disconnect()` here — `main()` is wrapped in a `.finally()` that owns
    // it. Disconnecting inside would work but duplicates the teardown, and a
    // second owner of a lifecycle is how a later early-return forgets one.
    process.exitCode = 1;
    return;
  }

  // ── SYMBOL EXCLUSIONS, printed BEFORE the ladder they alter ─────────
  //
  // MONEY-1255 (D3). Above the per-ratio lines on purpose: these removals change
  // what every line below says, and a disclosure that arrives after the verdict
  // is a footnote to a decision already taken.
  //
  // Printed UNCONDITIONALLY, zeros included. `tallySymbolExclusions` seeds from
  // the declared list rather than from the rows precisely so a symbol that
  // removed nothing gets a line — that is the row that told us CENTUM and DVL
  // did not belong in `xbrl-reconcile.ts`, and it is the row that will tell the
  // next reader if they do not belong here either.
  const symbolExcluded = judgements.filter((j) =>
    EXCLUDED_SYMBOL_SET.has(j.symbol),
  );
  /** The population every rate below is computed over. */
  const graded = judgements.filter((j) => !EXCLUDED_SYMBOL_SET.has(j.symbol));
  const symbolTallies = tallySymbolExclusions(
    symbolExcluded.map((j) => ({
      symbol: j.symbol,
      // `field` in the tally's vocabulary is "the thing compared" — a COLUMN in
      // the financials gate, a RATIO here.
      field: j.ratio,
      verdict: j.outcome,
    })),
    Object.keys(EXCLUDED_SYMBOLS),
  );
  log.info("");
  log.info(
    `SYMBOL EXCLUSIONS: ${symbolExcluded.length} comparison(s) across ` +
      `${symbolTallies.length} declared symbol(s) removed from every rate below.`,
  );
  log.warn(
    `  THIS IS NOT A DECLARED DIVERGENCE. A declaration says two sides measure ` +
      `different quantities and grades the whole ratio DECLARED_DIVERGENCE. ` +
      `This removes specific SYMBOLS from a ratio that is still graded — it ` +
      `explains nothing and agrees to arm over rows already found to be wrong. ` +
      `Read every verdict below as "READY EXCEPT FOR THESE".`,
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
      // being clean: either something upstream (a bank skip, a coverage gap, a
      // CLOSING-basis skip) already removed every row — in which case this
      // entry buys nothing and claims credit for another mechanism's work — or
      // the symbol is simply not a problem for THIS gate, which is what moved
      // these two out of `xbrl-reconcile.ts` in the first place.
      log.warn(
        `${"      "}REMOVED NOTHING. Either an upstream exclusion already took ` +
          `every row for this symbol, or it is not a defect in THIS gate at ` +
          `all. Confirm which before treating this entry as load-bearing, and ` +
          `move it to the gate whose verdict it actually changes.`,
      );
    }
  }
  log.info("");

  // ── THE FILL CENSUS: WHAT ARMING WOULD ACTUALLY WRITE — MONEY-1401 F8 ────
  //
  // A SECOND, SEPARATE population, and that separation is the fix. Every rate
  // above is computed over the symbols this gate GRADED — joined to the
  // incumbent on the FILING's exchange, which is `"NSE"` on all 108,073 rows.
  // The writer keys its upsert on the INSTRUMENT's exchange and REFUSES when
  // the two disagree, and `XBRL_ARM_WHERE` is a relation on `instrumentId`, not
  // a (symbol, exchange) match. Measured on prod 2026-09-13: 1,870 of the 2,025
  // graded symbols (92.3%) have their annual winner on an instrument the writer
  // cannot reach.
  //
  // So the rung that asks "would arming REPLACE a populated column with an
  // emptier one" has to be counted here and not off `weHave`/`theyHave`. Three
  // differences from the graded population, all of them deliberate:
  //
  //   1. WRITER-REACHABLE ONLY — the annual winner's `instrumentId` must be an
  //      ACTIVE instrument on the filing's own exchange.
  //   2. LENDERS INCLUDED — the writer writes them.
  //   3. OUR side is the WRITE PLAN, not `deriveRatios`' output: the annual
  //      recency bound (F10) and `isPlanWorthWriting`'s row-level veto both
  //      refuse columns a raw derivation would have produced.
  //
  // `deriveValuation` is not run here, so the plan is built with an EMPTY
  // valuation. That can only UNDER-count our side — `isPlanWorthWriting`
  // excludes every market-derived column from its floor anyway — and
  // under-counting is the strict direction on a one-way door.
  const fillXbrl = new Map<RatioKey, number>(RATIOS.map((r) => [r, 0]));
  const fillVendor = new Map<RatioKey, number>(RATIOS.map((r) => [r, 0]));
  let fillPopulation = 0;
  let fillStaleAnnual = 0;
  let fillNotWorthWriting = 0;
  let fillUnreadableFacts = 0;
  for (const f of newest.values()) {
    if (!writerReachable.has(f.symbol)) continue;
    // The same declared exclusions every rate above applies — a census over a
    // population two rows wider than the verdict beside it is the defect this
    // whole block is fixing, restated.
    if (EXCLUDED_SYMBOL_SET.has(f.symbol)) continue;

    // BOTH SIDES ARE COUNTED AFTER THE REFUSALS — MONEY-1401 F8b.
    //
    // The vendor tally used to be taken HERE, ahead of the three `continue`s
    // below, while ours is taken after them. So every symbol the writer REFUSES
    // — a stale annual, unreadable facts, a plan not worth writing — counted on
    // the vendor side and on neither of ours, and the rung's own question
    // ("would arming REPLACE a populated column with an emptier one?") was
    // answered wrong for it: a refused row is never written, so it replaces
    // NOTHING. At the measured 60.6% stale rate that alone drove every ratio in
    // `FILL_BLOCKING_RATIOS` to BLOCK by construction, for a reason false on
    // most of its own inputs.
    //
    // `fillPopulation` moves with them. It is the floor
    // (`FILL_MIN_POPULATION`) under "two counts over an empty population always
    // agree", so it has to be the size of the population those two counts were
    // actually taken over — counting it wider is the same defect one level up.
    // The refusals stay counted and printed separately, so nothing is hidden by
    // the move.

    // OUR side, through the writer's own refusals.
    if (annualRecencyVerdict(f.periodEnd, RUN_NOW) === "STALE") {
      fillStaleAnnual++;
      continue;
    }
    const facts = readFacts(f.facts);
    if (facts === null) {
      fillUnreadableFacts++;
      continue;
    }
    const priorRows = (bySymbol.get(f.symbol) ?? []).filter(
      (r) => r.periodEnd < f.periodEnd,
    );
    const prior =
      priorRows.length > 0
        ? pickWinner(priorRows, new Date(f.periodEnd.getTime() - 1))
        : undefined;
    const plan = planRatiosWrite(
      deriveRatios(facts, readFacts(prior?.facts) ?? undefined),
      {},
      "ANNUAL",
    );
    // A plan the writer would REFUSE contributes nothing to any column — the
    // veto is on the whole ROW, so counting its columns would credit us with
    // values that are never stored.
    if (!isPlanWorthWriting(plan).write) {
      fillNotWorthWriting++;
      continue;
    }

    fillPopulation++;
    const inc = incumbents.get(`${f.symbol}\u0000${f.exchange}`);
    for (const key of RATIOS) {
      if ((plan.set as Record<string, unknown>)[key] !== undefined) {
        fillXbrl.set(key, (fillXbrl.get(key) ?? 0) + 1);
      }
      const v = inc?.[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        fillVendor.set(key, (fillVendor.get(key) ?? 0) + 1);
      }
    }
  }

  log.info("");
  log.info(
    `FILL CENSUS (the WRITER's population, not the grader's): ` +
      `${fillPopulation} symbol(s) the writer would ACTUALLY WRITE, out of ` +
      `${writerReachable.size} writer-reachable and ${newest.size} in the ` +
      `graded population. Refused before the count: ${fillStaleAnnual} for a ` +
      `stale ANNUAL, ${fillNotWorthWriting} for a plan not worth writing, ` +
      `${fillUnreadableFacts} for unreadable facts — BOTH sides of the census ` +
      `are counted over the survivors, because a row the writer refuses ` +
      `replaces nothing.`,
  );
  if (writerReachable.size < newest.size / 2) {
    log.warn(
      `  Most of this gate's population is UNREACHABLE by the writer. That is ` +
        `the MONEY-1299 instrument mis-resolution, not a property of the data: ` +
        `run scripts/data/reresolve-xbrl-instruments.ts and re-run this gate.`,
    );
  }

  const gateJudgements: RatioGateJudgement[] = [];
  log.info("per-ratio:");
  for (const key of RATIOS) {
    const rows = graded.filter((j) => j.ratio === key);
    const comparable = rows.filter((j) => j.outcome !== "INCOMPARABLE");
    const match = comparable.filter((j) => j.outcome === "MATCH").length;
    const scale = rows.filter((j) => j.outcome === "SCALE_MISMATCH").length;
    const sign = rows.filter((j) => j.outcome === "SIGN_MISMATCH").length;

    // Self-comparisons, per ratio — MONEY-1237. Counted over `comparable`, not
    // `rows`, to match what `judgeRatioReadiness` subtracts: an INCOMPARABLE
    // pair is already outside both sides of the fraction, so counting it here
    // would over-subtract and drain the denominator below zero.
    const selfComparisons = comparable.filter((j) => j.selfComparison).length;
    const selfMatched = comparable.filter(
      (j) => j.selfComparison && j.outcome === "MATCH",
    ).length;

    // WHICH SIDE IS EMPTY — MONEY-1234.
    //
    // `INCOMPARABLE` fuses two opposite situations, and the difference decides
    // who has work to do. Measured on prod 2026-08-21, the vendor's own
    // `stock_ratios` table barely holds the ratios this gate checks:
    //
    //     operatingMargin      0 of 2,135   (0.0%)
    //     netMargin           86 of 2,135   (4.0%)
    //     roa                 85 of 2,135   (4.0%)
    //     debtToEquity        86 of 2,135   (4.0%)
    //     roe              2,038 of 2,135  (95.5%)
    //
    // So `operatingMargin` can never be judged here — not because our
    // derivation is weak, but because there is nothing on the other side of the
    // comparison and never has been. Reporting that as "TOO FEW COMPARABLE"
    // points the reader at our data, which is the wrong place to look.
    const weHave = rows.filter((j) => j.derived !== null).length;
    const theyHave = rows.filter((j) => j.incumbent !== null).length;

    // THE SAME PAIRS, RESTRICTED TO WHAT ARMING WOULD STORE — MONEY-1401 F8b.
    //
    // Not a replacement for the rates above: those grade the DERIVATION, whose
    // population is every symbol, and narrowing them would drop `roa` /
    // `netMargin` / `debtToEquity` from ~80 vendor rows to ~3 and lose a real
    // `roce` blocker to an accident of instrument resolution. This is an EXTRA,
    // STRICT-ONLY rung: the ladder cannot see a ratio that agrees across the
    // 92.3% the writer refuses and disagrees on every row it stores.
    const writableRows = comparable.filter((j) => j.writable);
    const writableMatched = writableRows.filter(
      (j) => j.outcome === "MATCH",
    ).length;

    // THE LADDER IS NOT DECIDED HERE — MONEY-1235.
    //
    // `judgeRatioReadiness` is pure and unit-tested in
    // `packages/core/__tests__/market-data/xbrl-ratios-gate.test.ts`. This
    // script's job is to FEED it and print the result. The ladder used to live
    // inline right here, untestable, and it could never return pass — which is
    // exactly the kind of thing an inline gate hides.
    const judgement = judgeRatioReadiness({
      ratio: key,
      comparable: comparable.length,
      matched: match,
      scaleMismatches: scale,
      signMismatches: sign,
      weHave,
      theyHave,
      // MONEY-1401 F8 — the WRITER's population. Deliberately NOT `weHave` /
      // `theyHave`, which are the graded population joined on the FILING's
      // exchange; see the census above and `judgeRatioFill`.
      fill: {
        xbrl: fillXbrl.get(key) ?? 0,
        vendor: fillVendor.get(key) ?? 0,
      },
      // MONEY-1401 F8b — the AGREEMENT rate over the writer-reachable cohort.
      writable: {
        comparable: writableRows.length,
        matched: writableMatched,
      },
      selfComparisons,
      selfMatched,
      // MONEY-1250. Absent for every ratio but `debtToEquity`, and absence is
      // the STRICT reading (grade it normally) — the opposite polarity to
      // `selfComparisons`, where a missing answer has to mean "contaminated".
      ...(DECLARED_DIVERGENCES[key] !== undefined
        ? { declaredDivergence: DECLARED_DIVERGENCES[key] }
        : {}),
    });
    gateJudgements.push(judgement);

    // ONE source of truth for the explanation too — MONEY-1237. This block used
    // to re-derive the reason inline from `verdict === "UNVERIFIABLE"` and print
    // "NO VENDOR DATA". That was already a second copy of the ladder's logic,
    // and adding a THIRD cause of UNVERIFIABLE (a contaminated population) would
    // have made the copy actively wrong: a self-comparison drain would have
    // printed "the incumbent has this ratio on 0 rows", which is the opposite of
    // what happened. The module's `reason` covers every rung it can return.
    const { verdict, matchRate, independentComparable } = judgement;

    log.info(
      // 20 wide, not 12: `DECLARED_DIVERGENCE` is 19 characters, and a verdict
      // that overflows its column runs into the match figures — which is the
      // one place a reader must not have to look twice (MONEY-1250).
      `  ${key.padEnd(18)} ${verdict.padEnd(20)} ` +
        `match ${match - selfMatched}/${independentComparable} ` +
        `(${(matchRate * 100).toFixed(1)}%), ` +
        `scale ${scale}, sign ${sign}, incomparable ${rows.length - comparable.length}` +
        // FILL, spelled out rather than left to be inferred from "[ours N,
        // theirs M]" — MONEY-1401. Those two numbers were already printed here
        // and nothing compared them, which is exactly how `roe` read READY
        // while our derivation covered TEN FEWER symbols than the column it was
        // about to overwrite.
        //
        // BOTH POPULATIONS ARE PRINTED — F8. The first pair is the GRADED set
        // (joined on the FILING's exchange); the second is what the WRITER can
        // actually reach, and only the second is what the FILL verdict judges.
        // Printing only one of them is how the rung came to answer a different
        // question than the one it asks: on prod 2026-09-13 they differ by
        // 92.3% of the population, and `roe` at 797 vs 807 — the regression
        // this rung shipped to catch — is entirely inside the cohort the writer
        // never displaces.
        `  [graded ours ${weHave} vs vendor ${theyHave}` +
        `; FILL(writable) ours ${judgement.fill?.xbrl ?? "?"} vs vendor ` +
        `${judgement.fill?.vendor ?? "?"}` +
        (judgement.fill === undefined || judgement.fill.verdict === "OK"
          ? ``
          : ` — ${judgement.fill.verdict}`) +
        // The AGREEMENT rate over that same writable cohort — F8b. Printed
        // beside the graded one rather than instead of it: the two answer
        // different questions ("is the arithmetic right" vs "is it right on the
        // rows we store"), and a reader shown only one cannot tell which of
        // them a verdict rests on.
        `; WRITABLE match ${judgement.writable?.matched ?? "?"}/` +
        `${judgement.writable?.comparable ?? "?"}` +
        (judgement.writable === undefined || judgement.writable.verdict === "OK"
          ? ``
          : ` — ${judgement.writable.verdict}`) +
        `]` +
        (selfComparisons > 0
          ? `  — ${selfComparisons} SELF-COMPARISON(S) EXCLUDED from the ` +
            `${comparable.length} comparable pair(s): the incumbent is already ` +
            `${XBRL_SOURCE}, so those hold XBRL against itself` +
            (selfMatched > 0
              ? ` (${selfMatched} of them "matched", which is what an inflated ` +
                `rate is made of)`
              : "")
          : "") +
        `  — ${judgement.reason}`,
    );
  }

  // A DECLARED ratio's pairs are still shown, but they SORT LAST and are
  // labelled — MONEY-1250.
  //
  // Leaving them interleaved and unlabelled was the mirror image of the defect
  // this ticket is closing: the per-ratio line says `debtToEquity` is NOT
  // GRADED, and thirty lines later BATAINDIA appears under "worst offenders"
  // looking exactly like a defect. One of the two readings has to be wrong, and
  // a reader has no way to tell which.
  //
  // They are not DROPPED, because they are the evidence the declaration rests
  // on: BATAINDIA at `xbrl=0 tickertape=0.869` is the zero-borrowings,
  // all-leases case in its purest form, and hiding it would make the
  // declaration unfalsifiable by the next reader.
  const isDeclared = (r: RatioKey): boolean =>
    DECLARED_DIVERGENCES[r] !== undefined;
  // A SYMBOL-EXCLUDED pair is listed here for the same reason a DECLARED ratio
  // is — MONEY-1255 (D3). These rows ARE the evidence the exclusion rests on:
  // CENTUM's `xbrl=-0.652 tickertape=+0.833` is the sign mismatch the entry
  // names, and dropping it from the only place a reader can see the numbers
  // would make the exclusion unfalsifiable by the next person. Listed, sorted
  // last, and labelled — never silently removed.
  const isSymbolExcluded = (s: string): boolean => EXCLUDED_SYMBOL_SET.has(s);
  const worst = judgements
    .filter((j) => j.outcome !== "MATCH" && j.outcome !== "INCOMPARABLE")
    .sort((a, b) => {
      const rank = (o: Outcome) =>
        o === "SCALE_MISMATCH" ? 0 : o === "SIGN_MISMATCH" ? 1 : 2;
      return (
        Number(isDeclared(a.ratio)) - Number(isDeclared(b.ratio)) ||
        Number(isSymbolExcluded(a.symbol)) -
          Number(isSymbolExcluded(b.symbol)) ||
        rank(a.outcome) - rank(b.outcome) ||
        (b.relDiff ?? 0) - (a.relDiff ?? 0)
      );
    });
  const show = VERBOSE ? 200 : 25;
  if (worst.length > 0) {
    log.info("");
    log.info(
      "worst offenders (scale → sign → disagreement; DECLARED ratios and " +
        "EXCLUDED symbols last):",
    );
    for (const j of worst.slice(0, show)) {
      log.info(
        `  ${j.symbol.padEnd(14)} ${j.ratio.padEnd(18)} ` +
          (isDeclared(j.ratio) ? "[NOT GRADED — declared] " : "") +
          (isSymbolExcluded(j.symbol)
            ? "[NOT GRADED — symbol excluded] "
            : "") +
          `${j.outcome.padEnd(15)} ` +
          // Labelled by PROVENANCE, not assumed to be the vendor — MONEY-1237.
          // A disagreement against our own projection is a real finding (our
          // writer vs our derivation), but printing it as `tickertape=` would
          // send someone to argue with a vendor about a number we wrote.
          (j.selfComparison
            ? `xbrl=${j.derived} incumbent(${XBRL_SOURCE}, SELF)=${j.incumbent}`
            : `xbrl=${j.derived} tickertape=${j.incumbent}`) +
          (j.relDiff !== null ? ` (${(j.relDiff * 100).toFixed(1)}% off)` : ""),
      );
    }
    if (worst.length > show) {
      log.info(`  … ${worst.length - show} more; re-run with --verbose`);
    }
  }

  // ── THE RUNG THAT NEEDS NO VENDOR, REPORTED — MONEY-1401 ────────────
  //
  // Tallied over the GRADED population: the declared symbol exclusions remove
  // rows from every rate above, so a rung measured over the wider set would be
  // describing a different population than the verdict it sits beside.
  let identityPassed = 0;
  let identityFailed = 0;
  let identityUncheckable = 0;
  for (const [symbol, verdict] of identityBySymbol) {
    if (EXCLUDED_SYMBOL_SET.has(symbol)) continue;
    if (verdict === "PASS") identityPassed++;
    else if (verdict === "FAIL") identityFailed++;
    else identityUncheckable++;
  }
  const identityChecked = identityPassed + identityFailed;
  log.info("");
  log.info(
    `BALANCE-SHEET IDENTITY (no vendor involved): ${identityPassed} of ` +
      `${identityChecked} checkable filing(s) balance to within ` +
      `0.1%; ${identityFailed} do NOT; ${identityUncheckable} were ` +
      `UNCHECKABLE (a leg is missing — counted apart, never as a pass).`,
  );
  if (identityFailed > 0) {
    log.info(
      `  Every other rung in this gate asks a vendor frozen on a 2026-03-21 ` +
        `snapshot whose sync job is retired. This one keeps answering after ` +
        `the switchover has destroyed the incumbent, which is why it gates.`,
    );
  }

  // ── THE POPULATION THIS GATE IS SILENT ABOUT — MONEY-1401 ───────────
  //
  // `noIncumbent` was already counted and never named. With no incumbent there
  // is no pair, so these symbols reach no `comparable`, no `matched` and no
  // rate: the gate cannot be wrong about them because it never says anything.
  // That is fine right up until a reader treats the verdict as a statement
  // about the universe.
  const cannotGradeTop: { symbol: string; marketCap: number | null }[] = [];
  if (cannotGradeSymbols.length > 0) {
    // `LatestQuote` keys on `instrumentId`, so the size measure comes through
    // the instrument relation. Best-effort by design: a symbol with no quote
    // row is listed with a null rather than dropped, because "we could not size
    // it" and "it is small" are different facts and only one of them is true.
    const quotes = await prisma.latestQuote.findMany({
      where: { instrument: { symbol: { in: cannotGradeSymbols } } },
      select: { marketCap: true, instrument: { select: { symbol: true } } },
    });
    const capBySymbol = new Map<string, number | null>();
    for (const q of quotes) {
      const prior = capBySymbol.get(q.instrument.symbol);
      // A symbol can be listed on both exchanges; keep the larger reading
      // rather than whichever row came back last.
      if (prior === undefined || (q.marketCap ?? -1) > (prior ?? -1)) {
        capBySymbol.set(q.instrument.symbol, q.marketCap);
      }
    }
    cannotGradeTop.push(
      ...cannotGradeSymbols
        .map((symbol) => ({
          symbol,
          marketCap: capBySymbol.get(symbol) ?? null,
        }))
        .sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1))
        .slice(0, 20),
    );
  }
  log.info("");
  log.info(
    `CANNOT GRADE: ${cannotGradeSymbols.length} symbol(s) hold an annual XBRL ` +
      `filing and NO vendor row at all. This run is SILENT about them — they ` +
      `are neither graded nor passed. They are also the switchover's entire ` +
      `coverage upside, which is why the number is printed beside the verdict ` +
      `rather than buried in the population lines above.`,
  );
  for (const t of cannotGradeTop) {
    log.info(
      `  ${t.symbol.padEnd(14)} marketCap ` +
        (t.marketCap === null ? `(no quote row)` : `${t.marketCap.toFixed(0)}`),
    );
  }

  log.info("");
  const context: RatiosRunContext = {
    identity: {
      passed: identityPassed,
      failed: identityFailed,
      uncheckable: identityUncheckable,
    },
    cannotGrade: { count: cannotGradeSymbols.length, top: cannotGradeTop },
    // MONEY-1401 F8 — the size of the census above. Without it, an empty
    // writer-reachable population makes every fill verdict read OK.
    fillPopulation,
    // MONEY-1401 F8b review — the set BOTH the census and the per-pair
    // `writable` tag are drawn from. The gate refuses when either grows past
    // it, which is the arithmetic signature of the two mutations that deleted
    // the reachability rule with the whole suite green. See
    // `RatiosRunContext.writerReachable`.
    writerReachable: writerReachable.size,
  };
  const outcome = judgeRatiosGate(gateJudgements, context);
  if (outcome.pass) {
    log.info(`VERDICT: ${outcome.summary}`);
  } else {
    log.warn(`VERDICT: ${outcome.summary}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error("[xbrl-ratios] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
