/**
 * The F3 reconcile must measure the population the WRITER persists — MONEY-1232.
 *
 * ## Why this test exists
 *
 * `scripts/data/xbrl-reconcile.ts` is the last gate before a ONE-WAY DOOR:
 * arming `XBRL_PROJECTION_APPLY=true`, after which the first XBRL write for a
 * period destroys the value it replaced (`StockFinancials` has no `source` in
 * its unique key). A gate that measures the wrong population is worse than no
 * gate, because its verdict looks authoritative.
 *
 * It measured the wrong one. `XbrlFiling`'s key is
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)`, so a company
 * filing both CONSOLIDATED and STANDALONE for one period has TWO rows — while
 * `StockFinancials` has NO `basis` in its key, so exactly one of them is ever
 * written. `xbrl-projection-writer.ts` groups and calls `selectFilingForPeriod`;
 * the reconcile selected `basis` and then never read it.
 *
 * Measured on prod 2026-08-20, ANNUAL only: **10,982 filings collapse to 6,549
 * rows**, so 4,433 comparisons — 40.4% — were against incumbents that would
 * never be replaced. The symptom was one symbol/period appearing twice with
 * different `ours` values.
 *
 * ## Why it asserts the CALL rather than the numbers
 *
 * The reconcile needs a database. What can be pinned without one is the property
 * that actually failed: that the gate uses the writer's own selector instead of
 * a second implementation that can drift from it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INCOME_FIELDS,
  BALANCE_SHEET_FIELDS,
} from "../../src/market-data/xbrl-projection";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const RECONCILE = strip(read("scripts/data/xbrl-reconcile.ts"));
const WRITER = strip(read("workers/src/processors/xbrl-projection-writer.ts"));
const RATIOS = strip(read("scripts/data/xbrl-ratios-validate.ts"));

describe("the reconcile gate measures what the writer persists", () => {
  it("imports the writer's selector instead of reimplementing it", () => {
    // Two implementations of "which sibling wins" is two things to keep in
    // step, and nothing would report them diverging — the gate would simply
    // start grading a population the writer no longer produces.
    assert.match(RECONCILE, /selectFilingForPeriod/);
    assert.match(RECONCILE, /from "@usemoney\/core\/market-data"/);
  });

  it("both the gate and the writer call it — neither hand-rolls a basis rank", () => {
    assert.match(WRITER, /selectFilingForPeriod\(/);
    assert.match(RECONCILE, /selectFilingForPeriod\(/);
    // A local `basis === "CONSOLIDATED"` in the gate is the drift this prevents.
    assert.doesNotMatch(RECONCILE, /basis\s*===\s*"CONSOLIDATED"/);
  });

  it("fetches every field the tie-break needs, or the winner is order-dependent", () => {
    // `selectFilingForPeriod` breaks ties basis -> coverage -> filedAt ->
    // sourceUrl and documents itself as needing a TOTAL order so the winner is
    // a function of the candidate SET. Fetch three of the four and ties resolve
    // by whatever order the query happened to return — the precise instability
    // that function exists to remove, reintroduced by an incomplete `select`.
    for (const f of ["basis", "coverage", "filedAt", "sourceUrl"]) {
      assert.match(
        RECONCILE,
        new RegExp(`${f}:\\s*true`),
        `${f} is not selected, so the sibling tie-break is not total`,
      );
    }
  });

  it("orders symbol-major so a --limit page cannot split a sibling pair", () => {
    // Ordering by periodEnd alone lets `take: LIMIT` cut BETWEEN a STANDALONE
    // filing and the CONSOLIDATED one that supersedes it, handing the period to
    // the loser. Only bites with --limit, which is exactly what someone reaches
    // for when spot-checking — it would fail in the situation where a person is
    // trying to build confidence in the gate.
    assert.match(RECONCILE, /orderBy:\s*\[\{\s*symbol:\s*"asc"\s*\}/);
    assert.match(WRITER, /orderBy:\s*\[\{\s*symbol:\s*"asc"\s*\}/);
  });

  it("reports the collapse instead of silently shrinking the population", () => {
    // "reconciling N filings" going quietly to a smaller N is indistinguishable
    // from the backfill having written less. The superseded count has to be on
    // the line.
    assert.match(RECONCILE, /superseded/);
  });
});

describe("the RATIOS half of the gate resolves siblings the same way", () => {
  // MONEY-1233. The financials reconcile and this validator are two halves of
  // ONE gate — `xbrl-ratios-daily` is armed by XBRL_RATIOS_APPLY (MONEY-1286
  // split the flags; the two gates disagreed on prod on 2026-08-30)
  // flag as the projection — and only the first half was fixed by MONEY-1232.
  //
  // The bug here wore a different disguise. The reduction was
  // `if (!newest.has(f.symbol))` over `orderBy: [symbol asc, periodEnd desc]`,
  // which yields the right CARDINALITY (one filing per symbol) but an arbitrary
  // CHOICE: two siblings sharing a periodEnd have equal sort keys, so "first
  // wins" means "whatever Mongo returned first". Measured on prod 2026-08-20,
  // 1,486 of 2,108 symbols (70.5%) were decided that way.
  //
  // And the exposure is LARGER than the financials case, not smaller:
  // `StockRatios` is @@unique([symbol, exchange]) with no period dimension, so
  // one row IS the symbol's entire ratio set — a mis-picked sibling replaces
  // everything rather than one period of a history.

  it("uses the shared selector rather than leaning on query order", () => {
    assert.match(RATIOS, /selectFilingForPeriod\(/);
    assert.match(RATIOS, /from "@usemoney\/core\/market-data"/);
  });

  it("does not hand-roll a basis preference", () => {
    // A local `basis === "CONSOLIDATED"` here would be a third implementation of
    // one rule, across two gates and a writer, with nothing reporting drift.
    assert.doesNotMatch(RATIOS, /basis\s*===\s*"CONSOLIDATED"/);
  });

  it("selects every field the tie-break needs", () => {
    for (const f of ["basis", "coverage", "filedAt", "sourceUrl"]) {
      assert.match(
        RATIOS,
        new RegExp(`${f}:\\s*true`),
        `${f} is not selected, so the tie-break is not total and ties fall back to query order`,
      );
    }
  });

  it("no longer derives the newest period from the query's ordering", () => {
    // The point is not that the ordering is wrong — it is that the result must
    // not DEPEND on it. The max is computed explicitly now.
    assert.doesNotMatch(RATIOS, /first wins/);
    assert.match(RATIOS, /periodEnd > a\.periodEnd/);
  });

  it("reports how many symbols were ambiguous instead of resolving them silently", () => {
    // Pinned on the INCREMENT, not on the word. The first version of this
    // asserted /ambiguous/ and stayed green when the counter stopped counting —
    // `let ambiguous = 0` and the log line both still matched. Fifth time this
    // session a "does the string appear somewhere" check sailed over a real
    // change; the mutation is what caught it.
    assert.match(RATIOS, /ambiguous\+\+;/);
  });
});

describe("the gate compares each column against the row that OWNS it", () => {
  // MONEY-1234. `StockFinancials` is keyed BY statement and each row carries
  // only its own columns — measured on prod 2026-08-21, 10,043 of 12,247 ANNUAL
  // keys have THREE rows (INCOME / BALANCE_SHEET / CASH_FLOW). RELIANCE FY 2024:
  //     BALANCE_SHEET  revenue=null      totalAssets=1755048
  //     CASH_FLOW      revenue=null      totalAssets=null
  //     INCOME         revenue=917121    totalAssets=null
  //
  // The lookup was `findFirst` with NO statementType, selecting all six fields
  // off whatever came back — in practice the BALANCE_SHEET row. So the income
  // half of the ladder scored 2 comparable pairs out of 213 while the
  // balance-sheet half scored 127. Those four fields were not disagreeing; they
  // were never asked. Fixing the join moved them to 194-212 comparable.
  //
  // The failure mode is what makes this worth pinning: reading a column off the
  // wrong row yields null, and null scores INCOMPARABLE — which reads as "thin
  // overlap with the vendor", an entirely plausible thing to shrug at.

  it("routes fields by the WRITER's own mapping, not a private copy", () => {
    // `INCOME_FIELDS` / `BALANCE_SHEET_FIELDS` are what `ownedFields()` hands
    // the writer. Importing them means the gate compares each column against the
    // row the writer would have written it to, by construction rather than by
    // agreement.
    assert.match(RECONCILE, /INCOME_FIELDS/);
    assert.match(RECONCILE, /BALANCE_SHEET_FIELDS/);
    assert.match(RECONCILE, /from "@usemoney\/core\/market-data"/);
  });

  it("looks up an INCOME row and a BALANCE_SHEET row separately", () => {
    assert.match(RECONCILE, /incomeRow/);
    assert.match(RECONCILE, /balanceRow/);
    assert.match(RECONCILE, /statementOf\(field\)/);
  });

  it("no longer fetches one row per period", () => {
    // The N+1: 54,160 sequential Atlas round-trips, measured at 6h20m elapsed
    // and 0.0% CPU before being killed unfinished. A gate that cannot be re-run
    // in reasonable time stops being re-run, which is its own failure.
    const code = RECONCILE;
    assert.doesNotMatch(code, /stockFinancials\.findFirst\(/);
    assert.match(code, /stockFinancials\.findMany\(/);
    assert.match(
      code,
      /statementType: \{ in: \["INCOME", "BALANCE_SHEET"\] \}/,
    );
  });

  it("reports how many incumbents it loaded and in how many queries", () => {
    // Makes the N+1 regression visible in the run's own output rather than only
    // in its wall-clock.
    assert.match(RECONCILE, /quer\(ies\)/);
  });
});

describe("the gate mirrors the writer's REFUSALS, and says what it removed", () => {
  // MONEY-1235. Two changes landed in the writer and the gate mirrored neither,
  // so its verdict described a writer that no longer exists:
  //
  //  1. `judgeFilingScale` QUARANTINES a filing whose magnitudes disagree with
  //     the same company's other filings by a power of ten. The 28 scale
  //     mismatches of 2026-08-21 — 1000x:12, 100x:11, 10x:4, 10000x:1, across 15
  //     (symbol, period) filings, in BOTH directions — are filers mis-declaring
  //     their own `roundingLabel`. The writer refuses them
  //     (`refusedScaleSuspect`) and never auto-corrects one, so the gate was
  //     BLOCKING on values that will never be written.
  //  2. `planFinancialsWrite` refuses a STANDALONE winner permission to displace
  //     a vendor incumbent (`STANDALONE_NO_DISPLACE`). The vendor value SURVIVES
  //     — there is no write to judge — and 3,208 of 10,879 winner periods (29.5%)
  //     are standalone-only, where a holding company's standalone revenue differs
  //     from its consolidated one by a MULTIPLE.
  //
  // ## Why the ASSERTIONS here are about the exclusion being LOUD
  //
  // Excluding a population is the same operation as MONEY-1196's draining
  // denominator — 3 disagreements in 5 usable comparisons reading as 3.0%
  // because 95 blanks padded it. The only thing separating this fix from that
  // bug is that every removal is printed next to what survived. So these cases
  // pin the reporting as hard as they pin the exclusion: a version of this file
  // that excludes correctly and prints nothing must fail.

  it("runs the writer's own detector rather than a second scale rule", () => {
    // Imported and CALLED. A gate that imports the detector and never invokes it
    // is the merged-not-wired shape that cost MONEY-1220 a release.
    assert.match(RECONCILE, /judgeFilingScale\(/);
    assert.match(RECONCILE, /from "@usemoney\/core\/market-data"/);
    // No private threshold. A local power-of-ten comparison here would be a
    // second detector with its own constants, disagreeing with the writer's
    // silently — on the one table with no `source` in its unique key.
    assert.doesNotMatch(RECONCILE, /Math\.log10\(/);
  });

  it("gives the detector every filing as context, and adds NO query for it", () => {
    // `judgeFilingScale` needs the SAME SYMBOL's other filings, and the writer
    // feeds it `observeScale` over the whole page BEFORE grouping. Two properties
    // have to hold here.
    //
    // (a) the context comes from `filings`, not from `winners`: a STANDALONE
    //     sibling that lost its period is still evidence about the company's
    //     units, and dropping the losers pushes symbols under the detector's
    //     3-sibling floor — turning a real judgement into INSUFFICIENT_CONTEXT
    //     for exactly the companies that file both bases.
    assert.match(RECONCILE, /observations\.set\(f\.id, obs\)/);
    assert.match(RECONCILE, /if \(winnerIds\.has\(f\.id\)\)/);
    assert.match(RECONCILE, /bySymbol\.get\(f\.symbol\)/);
    // (b) exactly ONE read of `xbrlFiling`. A per-period context lookup is the
    //     N+1 that made this script un-runnable at 6h20m elapsed and 0.0% CPU
    //     (MONEY-1234) — the same defect, reintroduced by the same feature.
    //
    //     RE-EXPRESSED, NOT RELAXED — MONEY-1287. This counted
    //     `xbrlFiling.findMany(` and required exactly 1. That read is now a
    //     symbol-paged loop (`readFilingsBySymbolPage`), because the single
    //     unbounded fetch of 108,020 filings x 5,786 bytes could not cross
    //     Prisma's napi string boundary at all — the gate exited 1 having
    //     compared nothing, which the runbook says must never read as "it
    //     matched". So the literal that used to encode "one read" would now
    //     encode "no read", and a count of `findMany` calls no longer maps onto
    //     the invariant.
    //
    //     The invariant is unchanged and is asserted HARDER: the script touches
    //     the `xbrlFiling` delegate exactly ONCE, and that once is the hand-off
    //     to the pager rather than a query. A per-period lookup therefore has
    //     nowhere to live — it cannot be a second `prisma.xbrlFiling.*` (the
    //     count fails) and it cannot be a second paged read (the call count
    //     fails). It now also catches a `findFirst`/`findUnique` N+1, which the
    //     old `findMany` literal never did. Page count is bounded by
    //     symbols/200, never by periods.
    assert.equal(
      (RECONCILE.match(/prisma\.xbrlFiling/g) ?? []).length,
      1,
      "the scale context must reuse the filings already in memory",
    );
    assert.doesNotMatch(
      RECONCILE,
      /prisma\.xbrlFiling\.(findMany|findFirst|findUnique)\(/,
      "the filings read must go through the symbol pager, not a direct query",
    );
    assert.equal(
      (RECONCILE.match(/await readFilingsBySymbolPage\(/g) ?? []).length,
      1,
    );
    // `id` is the detector's join key — `ScaleObservation` excludes the
    // candidate from its own context by `filingId`. Unselected, every filing
    // would be its own sibling and the median would include the outlier.
    assert.match(RECONCILE, /id: true/);
  });

  it("asks planFinancialsWrite what it would DO instead of re-deriving it", () => {
    // The exclusion IS the writer's verdict, not a copy of its rule. The
    // existing case above already forbids a hand-rolled `basis === "CONSOLIDATED"`;
    // this is the positive half — the planner has to actually be called, per
    // STATEMENT, because a standalone filing may be refused the BALANCE_SHEET row
    // a vendor owns while CREATING the INCOME row nobody has.
    assert.match(RECONCILE, /planFinancialsWrite\(\{/);
    assert.match(RECONCILE, /plan\.action === "SKIP"/);
    assert.match(
      RECONCILE,
      /skipOf\.set\(statement\.statementType, plan\.skipReason\)/,
    );
  });

  it("both exclusions leave the ladder's denominators", () => {
    // The ladder is built from GRADED comparisons only. Pinned on the reduction
    // itself, not on the word: an earlier version of a sibling case asserted a
    // string appeared somewhere and stayed green while the counter it named had
    // stopped counting.
    assert.match(
      RECONCILE,
      /const graded = comparisons\.filter\(\(c\) => c\.excluded === undefined\)/,
    );
    assert.match(RECONCILE, /for \(const c of graded\) \{/);
    // The old build folded EVERY comparison into the per-field verdict list.
    // Left in place, the exclusions would be computed, reported, and then
    // graded anyway — the worst of both, and invisible.
    assert.doesNotMatch(RECONCILE, /for \(const c of comparisons\) \{/);
    // Quarantine tags the whole filing; the write plan tags one statement. Both
    // reach the comparison through the same `excluded` field.
    assert.match(RECONCILE, /skipOf\.set\("INCOME", "QUARANTINED"\)/);
    // RENAMED to `writerSkip` by MONEY-1255, and the rename carries meaning:
    // `excluded` is now the writer's refusals PLUS this run's SYMBOL exclusions,
    // which are NOT writer refusals. This assertion is about the writer half —
    // that the gate ASKS THE PLANNER rather than re-deriving the skip — so it
    // follows the writer half to its new name. `INCUMBENT-NULLING is keyed on
    // the WRITER's skip` in the MONEY-1255 block below pins that the two stayed
    // separate.
    assert.match(
      RECONCILE,
      /const writerSkip = skipOf\.get\(statementOf\(field\)\)/,
    );
    assert.match(
      RECONCILE,
      /const excluded: Exclusion \| undefined =\s*\n?\s*writerSkip \?\?/,
    );
  });

  it("tags excluded rows instead of dropping them, or recall is unmeasurable", () => {
    // A `continue` at the quarantine would make the gate quieter AND
    // unfalsifiable: the detector's recall against the 28 known mismatches is
    // only computable while the caught ones are still in the list, and "how many
    // comparisons did this remove" cannot be counted from rows that were never
    // created.
    assert.match(
      RECONCILE,
      /\.\.\.\(excluded !== undefined \? \{ excluded \} : \{\}\)/,
    );
    assert.match(
      RECONCILE,
      /const excludedRows = comparisons\.filter\(\(c\) => c\.excluded !== undefined\)/,
    );
  });

  it("prints both exclusions rather than only shrinking the denominator", () => {
    // Quarantine: its own reported bucket, with the inferred factors, split by
    // whether a vendor row existed — because only those left a denominator.
    assert.match(RECONCILE, /QUARANTINED by the scale detector/);
    // The split that makes the bucket auditable: which quarantined periods took
    // comparisons out of a denominator (they had a vendor row) and which did not.
    assert.match(RECONCILE, /\$\{quarantinedWithVendor\} with a vendor row/);
    assert.match(RECONCILE, /histogram\(quarantineFactors\)/);
    // Write-plan skips: printed from the counter map, so a reason added to
    // `FinancialsSkipReason` appears without anyone updating a list here.
    assert.match(RECONCILE, /\[\.\.\.plannedSkips\.entries\(\)\]/);
    // And a ZERO is louder than a number. 3,208 of 10,879 winner periods are
    // standalone-only, so no skips at all means the mirror is not reaching the
    // planner — the merged-not-wired shape, which a silently smaller population
    // would never reveal.
    assert.match(RECONCILE, /ZERO STANDALONE_NO_DISPLACE skips/);
    // The CONDITION too. `if (false)` around the warn leaves the sentence in the
    // file and deletes the alarm.
    assert.match(
      RECONCILE,
      /\(plannedSkips\.get\("STANDALONE_NO_DISPLACE"\) \?\? 0\) === 0/,
    );
  });

  it("leads each field's line with the SURVIVING comparable count", () => {
    // `match N/compared` was the old headline and it is the draining-denominator
    // reading: `compared` counts blanks, so the fraction moves for reasons that
    // have nothing to do with agreement. `comparable` is the number the rate is
    // actually computed over and the number an exclusion changes.
    assert.match(
      RECONCILE,
      /comparable \$\{v\.comparable\} of \$\{v\.compared\} judged/,
    );
    assert.doesNotMatch(RECONCILE, /match \$\{v\.matched\}\/\$\{v\.compared\}/);
    // Per field, what the exclusions removed and what they hid.
    assert.match(
      RECONCILE,
      /excluded \$\{e\.comparable\} comparable of \$\{wouldBe\}/,
    );
    // And the GUARD that decides whether the line prints at all. `if (false && e)`
    // leaves every string above intact and deletes the whole exclusion report —
    // it escaped this case until the mutation run found it.
    assert.match(
      RECONCILE,
      /const e = excludedByField\.get\(field\);\s*\n\s*if \(e\) \{/,
    );
    assert.match(RECONCILE, /among them scale \$\{e\.scale\}/);
    // And the number that makes the EXCLUSION's own premise falsifiable. The
    // reason standalone-vs-vendor pairs leave the ladder is that they measure a
    // BASIS gap, not a data-quality one; if that is true the excluded rows
    // disagree MORE than the survivors. When they do not, the exclusion bought a
    // smaller sample rather than a cleaner one, and the report has to say so —
    // otherwise a rate that failed to move looks like a rate that moved a little.
    // PINNED ON THE DECISION, NOT THE ARITHMETIC — MONEY-1249.
    //
    // This case used to assert the literal expression
    // `e.disagree / e.comparable` and the literal guard
    // `excludedRate <= rate`. It was written to be mutation-resistant and it
    // succeeded at that — while CERTIFYING A BUG. `rate` is a percentage
    // (`… * 100`) and that expression is a fraction, so the comparison was
    // `0.143 <= 8.0`: true for any excluded rate under 100% against any graded
    // rate over 1%. The guard could not fail, the refutation printed on all six
    // fields, and this test held the defective line in place.
    //
    // A test hardened against mutation can still be wrong about WHICH text to
    // hold. The fix is to assert that the decision comes from a judge whose
    // BEHAVIOUR is unit-tested (`judgeExclusionComparison`, with the three real
    // prod rows and both inverse controls), and to assert the shape of what the
    // script does with each verdict — not the shape of the sum.
    assert.match(
      RECONCILE,
      /judgeExclusionComparison\(\{/,
      "the decision must come from the tested judge, not an inline comparison",
    );
    assert.doesNotMatch(
      RECONCILE,
      /excludedRate <= rate/,
      "an inline comparison is how the unit mismatch got in and stayed in",
    );
    // Both verdicts must be REACHABLE from the script. Before MONEY-1249 the
    // gate had no words for the HOLDS case at all — it could only ever say the
    // hypothesis was refuted.
    assert.match(RECONCILE, /BASIS_HYPOTHESIS_HOLDS/);
    assert.match(RECONCILE, /BASIS_HYPOTHESIS_REFUTED/);
    assert.match(RECONCILE, /basis-mismatch explanation does NOT hold/);
    assert.match(
      RECONCILE,
      /disagree MORE than the graded ones/,
      "the supporting case needs its own sentence, or it reads as silence",
    );
  });

  it("a field that reads READY only because its blockers were excluded says so", () => {
    // The precise defect this ticket must not introduce. `judgeSwitchoverReadiness`
    // blocks on ANY surviving scale or sign mismatch, so once the quarantine
    // removes them the line prints `scale 0` and reads exactly like a field that
    // never had one. The verdict is still correct — the writer will not write
    // those rows — but it is a statement about a different population, and the
    // reader has to be told which.
    assert.match(RECONCILE, /READY RESTS ON THE EXCLUSION/);
    assert.match(RECONCILE, /v\.ready && \(e\.scale > 0 \|\| e\.sign > 0\)/);
    // And the same for volume: past a share of the field's comparable pairs, the
    // removal stops being a footnote.
    assert.match(RECONCILE, /share >= EXCLUDED_SHARE_NOTE/);
  });

  it("reports the detector's RECALL against the mismatches a vendor can see", () => {
    // The 28 are the only sample where a second source can adjudicate, so this
    // cross-tab is the detector's entire measurable recall — and it is expected
    // to be partial (`MIN_SIBLING_PERIODS` is 3; a symbol with two filings has no
    // oracle). Each miss names its own cause, because "INSUFFICIENT_CONTEXT, 2
    // siblings" is coverage the backfill can close while "OK, 9 siblings" is the
    // detector disagreeing with the vendor and needs a human.
    assert.match(RECONCILE, /recall over the vendor-visible population/);
    // The guard, for the same reason as the exclusion line: gating the whole
    // block off leaves every sentence in the file.
    assert.match(
      RECONCILE,
      /if \(scaleRows\.length > 0 \|\| quarantinedPeriods > 0\) \{/,
    );
    assert.match(RECONCILE, /scaleJudgements\.get\(id\)/);
    assert.match(RECONCILE, /sibling period\(s\)/);
  });

  it("never tunes its own thresholds to reach a verdict", () => {
    // `judgeSwitchoverReadiness` enforces the floor (a minimum COMPARABLE count,
    // blanks excluded — the MONEY-1196 fix) and the disagreement-rate ceiling.
    // This script passes NO overrides, deliberately: excluding populations makes
    // a high match rate reachable on a small survivor set, and a gate that can
    // also move its own floor has nothing left holding it in place.
    assert.match(RECONCILE, /judgeSwitchoverReadiness\(verdicts\)/);
    assert.doesNotMatch(RECONCILE, /minComparable/);
    assert.doesNotMatch(RECONCILE, /maxDisagreementRate/);
    // The detector's constants are equally off-limits from here. Pinned on the
    // ASSIGNMENT, not the word: the recall block names both constants in a log
    // line telling the reader NOT to loosen them, and the first version of this
    // case went red against its own advice — a bare `/LOG10_THRESHOLD/` matching
    // the prose that exists to prevent the thing being asserted about. Stripping
    // comments does not help when the text lives in a template literal.
    assert.doesNotMatch(RECONCILE, /MIN_SIBLING_PERIODS\s*=/);
    assert.doesNotMatch(RECONCILE, /LOG10_THRESHOLD\s*=/);
  });

  it("has no dead reporting branch", () => {
    // A catch-all for the mutation class that escaped every string assertion in
    // this file: wrap a report block in `if (false)` and the source still
    // contains every sentence, every counter name and every format string, while
    // the run prints nothing. Each block's own guard is pinned individually
    // above; this is the cheap net under all of them, including blocks added
    // later by someone who did not read this comment.
    assert.doesNotMatch(RECONCILE, /if \(\s*false/);
  });

  it("says WHICH SIDE of an INCOMPARABLE pair was empty — MONEY-1250", () => {
    // THE DEFECT. `incomparable N` is the one number in this report that cannot
    // be acted on: it adds a coverage GAP (we have nothing, the vendor does) to
    // a coverage WIN (we have something, the vendor does not), and those call
    // for opposite responses. Measured on prod 2026-08-24, `totalAssets` read
    // `comparable 2555 of 4744` where the 2,189 shortfall was 2,165 GAP / 19
    // WIN / 5 neither — i.e. essentially all of it was ground WE do not cover,
    // and nothing in the output said so. The `unverifiable` exemption already
    // needed the distinction and computed it for ONE field; five others were
    // left to be guessed at.
    //
    // Pinned on the CALL, like `judgeExclusionComparison`: an inline
    // `ours === undefined ? gap : win` mis-files a both-blank pair as a gap on
    // our side, which inflates precisely the number the block exists to make
    // honest.
    assert.match(
      RECONCILE,
      /splitIncomparable\(/,
      "the split must come from the tested function, not an inline branch",
    );
    assert.match(RECONCILE, /ours blank/);
    assert.match(RECONCILE, /a coverage GAP/);
    assert.match(RECONCILE, /a coverage WIN/);
    // The GUARD, for the same reason the exclusion line's guard is pinned:
    // `if (false && blanks)` leaves every sentence above intact and prints
    // nothing.
    assert.match(RECONCILE, /if \(blanks && v\.incomparable > 0\) \{/);
    // The standalone-vs-consolidated question this ticket opened on must be
    // ANSWERED in the output, not left for the reader to assume. A
    // standalone-only winner whose vendor row exists is excluded by
    // STANDALONE_NO_DISPLACE and never reaches the shortfall at all, so reading
    // the shortfall as a basis problem is exactly backwards.
    assert.match(RECONCILE, /OURS-BLANK:/);
    assert.match(
      RECONCILE,
      /const oursBlankRows = graded\.filter\(/,
      "the block must describe GRADED pairs — an excluded row is not a write",
    );
    // ONE definition of "ours blank". A second inline predicate agrees today
    // and drifts the first time either side learns about a new kind of absent
    // value — the two-copies-of-one-ordering defect `basisRank` was extracted
    // to end.
    assert.match(
      RECONCILE,
      /classifyIncomparable\(c\) === "OURS_BLANK"/,
      "the ours-blank predicate must be the tested one, not a local copy",
    );
    assert.doesNotMatch(
      RECONCILE,
      /c\.ours === undefined &&\s*\n?\s*c\.theirs !== undefined/,
      "an inline ours-blank test is a second definition of the same thing",
    );
    assert.match(RECONCILE, /have a STANDALONE winner/);
    assert.match(
      RECONCILE,
      /nothing to consolidate/,
      "the measured NSE finding has to be stated, or the theory outlives it",
    );
  });

  it("the surviving-scale diagnosis describes the MISSES, not every mismatch", () => {
    // MONEY-1234's systematic-vs-per-filing block was repointed at `graded`. Left
    // on the full population it would keep describing filings the writer has
    // already quarantined, and the operator's next action — "fix the conversion"
    // versus "understand these six" — depends on which set it is looking at.
    assert.match(
      RECONCILE,
      /const scaled = graded\.filter\(\(c\) => c\.verdict === "SCALE_MISMATCH"\)/,
    );
    assert.doesNotMatch(
      RECONCILE,
      /const scaled = comparisons\.filter\(\(c\) => c\.verdict === "SCALE_MISMATCH"\)/,
    );
  });
});

describe("MONEY-1237 — a contaminated reconcile must not print READY", () => {
  /** LINE comments before BLOCK — MONEY-1143. */
  const CODE = RECONCILE.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("the xbrlIncumbents count REACHES the verdict, not just a log line", () => {
    // THE DEFECT. `xbrlIncumbents` was counted, warned about, and then dropped:
    // `allReady` came only from the per-field verdicts and the exit code only
    // from `allReady`. So a run where every incumbent was already NSE_XBRL —
    // exactly what re-running this gate AFTER arming produces, the natural
    // "confirm it worked" move — compared XBRL against itself, matched 100%,
    // printed "VERDICT: every field is READY" and exited 0.
    //
    // The old warning told the reader to "subtract them before believing a
    // READY", which handed the arithmetic of a one-way door to whoever was
    // reading log output.
    assert.match(
      CODE,
      /const contaminated = xbrlIncumbents > 0;/,
      "the count must be turned into a decision",
    );
    assert.match(
      CODE,
      /if \(contaminated\) allReady = false;/,
      "contamination must clear allReady, which is what the exit code reads",
    );
  });

  it("the decision is made BEFORE the verdict is printed", () => {
    // Ordering is the whole fix: setting `allReady` after the log line would
    // leave the printed verdict saying READY while the exit code said otherwise
    // — two answers, and the human reads the louder one.
    const decide = CODE.indexOf("if (contaminated) allReady = false;");
    const verdict = CODE.indexOf("VERDICT: every field is READY");
    assert.ok(decide > 0 && verdict > 0, "could not locate both sites");
    assert.ok(
      decide < verdict,
      "allReady must be cleared before the verdict string is chosen",
    );
  });

  it("names the remedy, because this is an ENVIRONMENT error not a data one", () => {
    // A gate that fails without saying what to do gets overridden. The fix here
    // is not "improve the data" — it is "run this somewhere the projection was
    // never armed".
    assert.match(CODE, /never been armed/);
  });
});

describe("MONEY-1237 — SIGN flags may be resolved by a tight translation; SCALE never", () => {
  const CODE2 = RECONCILE.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("the translation attempt runs on SIGN_MISMATCH as well as DISAGREEMENT", () => {
    // THE PROVING CASE. BOMDYEING FY2021: ours (rev − totExp + FC) = −8.22 vs
    // vendor +81.82 was classified a systematic SIGN error — while the vendor's
    // value equals its own declared definition, PBT + FC = 81.85, to 0.04%.
    // Near breakeven an operations-only figure and an other-income-inclusive
    // one legitimately sit on opposite sides of zero; blocking the ladder on
    // that is blocking on a definitional artefact.
    assert.match(
      CODE2,
      /r\.verdict === "DISAGREEMENT" \|\| r\.verdict === "SIGN_MISMATCH"/,
    );
  });

  it("SCALE_MISMATCH still pre-empts translations entirely", () => {
    // A power-of-ten gap is a units bug and must never be laundered by trying a
    // different quantity until one happens to land.
    // Scoped to the translation gate's own variable (`r`); an unrelated
    // summary filter elsewhere legitimately mentions SCALE_MISMATCH on `c`.
    assert.doesNotMatch(CODE2, /r\.verdict === "SCALE_MISMATCH"/);
  });

  it("resolved sign flags are COUNTED separately, not silently absorbed", () => {
    // The guard against this becoming a blanket excuse: a genuine sign bug —
    // |theirs| ≈ |ours|, a loss stored as a positive magnitude — matches no
    // definitional candidate and still classifies SIGN_MISMATCH (MODIRUBBER
    // FY2025 does exactly that and stays flagged). The count makes the split
    // auditable in every run's output.
    assert.match(CODE2, /signResolvedByTranslation = primaryWasSign;/);
    assert.match(CODE2, /signTranslations\+\+/);
    assert.match(CODE2, /OPPOSITE SIGNS on the primary/);
  });
});

describe("MONEY-1237 — the gate mirrors the writer's refusals, context and drain limits", () => {
  const CODE3 = RECONCILE.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("eligibility runs BEFORE grouping, on the writer's own judge", () => {
    // Without this a 546-day transition-year filing shared a group with the
    // 365-day one and could WIN it on coverage — 18 months of revenue graded
    // against the vendor's 12 and reported as a data defect — and the coverage
    // gain counted the 357 HALF_YEARLY rows as ground XBRL covers.
    assert.match(CODE3, /judgeProjectionEligibility\(\{/);
    assert.match(CODE3, /periodStart: true,/);
    assert.match(CODE3, /targetOf\.set\(f\.id, verdict\.target\);/);
    // The group key comes from the VERDICT's target, not re-derived fields.
    assert.match(
      CODE3,
      /\$\{verdict\.target\.periodType\}\\u0000\$\{verdict\.target\.period\}/,
    );
  });

  it("the AUTHORITATIVE scale verdict is scoped to the candidate's OWN period type", () => {
    // Same function as the writer is not the same verdict unless the CONTEXT
    // matches. The original scoping was a hardcoded `Set(["ANNUAL"])` mirroring
    // the nightly scheduler payload — right in intent, and it switched the
    // detector OFF for every QUARTERLY filing: a quarterly candidate is not in
    // an ANNUAL-only array, so `resolveOrder` could not place it and the verdict
    // was INSUFFICIENT_CONTEXT every time, indistinguishable from a first-ever
    // filer. The quarantine was therefore off for exactly the population the
    // `createMissing` drain is about to write (MONEY-1236).
    //
    // Keying by (symbol, periodType) keeps the original guarantee — an ANNUAL
    // candidate still sees only ANNUAL siblings — without depending on a
    // constant that has to be kept in sync with a scheduler payload.
    assert.match(
      CODE3,
      /judgeFilingScale\(\s*candidate,\s*bySymbolScoped\.get\(scopeKey\(f\.symbol, f\.periodType\)\)/,
    );
    assert.match(
      CODE3,
      /const scopeKey = \(symbol: string, periodType: string\) =>/,
    );
    assert.doesNotMatch(
      CODE3,
      /NIGHTLY_PERIOD_TYPES/,
      "the hardcoded ANNUAL-only scope must be gone, not merely bypassed",
    );
    assert.match(CODE3, /scopeDivergence\+\+/);
    assert.match(CODE3, /siblingDistribution\.set/);
  });

  it("the observation carries periodEnd, so ordering is DATED like the writer's", () => {
    // Without a date `resolveOrder` falls to its array-position fallback, so the
    // gate ordered its series by a different rule than the writer it measures.
    // The value was already selected and already used for the label.
    assert.match(CODE3, /periodEnd: f\.periodEnd,\s*label: periodLabel\(/);
  });

  it("a CALLER-BUG context is counted and blocks the readiness verdict", () => {
    // `CANDIDATE_NOT_IN_CONTEXT` is the detector's new name for "you handed me a
    // context without the filing in it". It must never again be readable as
    // "not enough history".
    assert.match(CODE3, /candidateNotInContext\+\+/);
    assert.match(CODE3, /insufficientReasons\.set/);
    assert.match(CODE3, /CANDIDATE_NOT_IN_CONTEXT/);
  });

  it("READY is withdrawn when exclusions drained half a field's pairs", () => {
    // judgeSwitchoverReadiness's floor of 20 predates the exclusions, so a
    // field could read READY on 20 survivors out of thousands — a verdict
    // about a remnant wearing the population's name.
    assert.match(CODE3, /const EXCLUSION_DRAIN_FLOOR = 0\.5;/);
    assert.match(CODE3, /share >= EXCLUSION_DRAIN_FLOOR/);
    assert.match(CODE3, /allReady = false;[\s\S]{0,400}EXCLUSION-DRAINED/);
  });
});

describe("MONEY-1236 — the gate's write-plan provenance matches the writer's", () => {
  /**
   * Pull the keys out of an object literal assigned to `name`.
   *
   * Brace-matched, and the spread form `...(x ? { k: v } : {})` counts as `k`,
   * because that is how BOTH files add their optional fields.
   */
  function provenanceKeys(src: string, name: string): Set<string> {
    const at = src.indexOf(`const ${name} = {`);
    assert.notEqual(at, -1, `${name} not found — has it been renamed?`);
    const start = src.indexOf("{", at);
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const body = src.slice(start, end);
    const keys = new Set<string>();
    for (const m of body.matchAll(/(?:^|[{,]|\?\s*\{)\s*(\w+)\s*:/g)) {
      keys.add(m[1]!);
    }
    return keys;
  }

  const gate = strip(read("scripts/data/xbrl-reconcile.ts"));
  const writer = strip(
    read("workers/src/processors/xbrl-projection-writer.ts"),
  );

  it("the gate passes `family` — a LENDER owns fewer columns", () => {
    // THE DEFECT. `planFinancialsWrite` narrows a banking/nbfc filing's owned
    // set (no `operatingIncome`, no `ebitda` — the concepts are in 10% and 0% of
    // lender filings). The writer passes `family`; the gate did not, and the
    // provenance type declares it OPTIONAL, so the omission compiled cleanly and
    // put the two on DIFFERENT owned sets for every lender — in a file whose own
    // header claims they "cannot drift apart".
    assert.ok(
      provenanceKeys(gate, "provenance").has("family"),
      "the reconcile's provenance must carry `family`",
    );
  });

  it("every provenance key the WRITER sends, the gate sends too", () => {
    // The general form, so the next added field cannot repeat this silently.
    // One-directional on purpose: the writer is the authority, and the gate
    // carrying an extra key is harmless.
    const writerKeys = provenanceKeys(writer, "filingProvenance");
    const gateKeys = provenanceKeys(gate, "provenance");
    const missing = [...writerKeys].filter((k) => !gateKeys.has(k));
    assert.deepEqual(
      missing,
      [],
      `the gate omits provenance field(s) the writer sends: ${missing.join(", ")}`,
    );
  });

  it("grades every field the WRITER owns — no hand-written short list", () => {
    // MONEY-1250. `FIELDS` was a literal six while the writer owned ten, so
    // `totalDebt`, `totalLiabilities`, `totalCash` and `otherIncome` were
    // written and never graded — and the run still ended "VERDICT: NOT ready
    // over the 24442 GRADED comparison(s)", which reads as a statement about the
    // writer's output. `stock_financials` holds 9,861 TICKERTAPE `totalDebt`
    // values and has no `source` in its unique key, so arming would have
    // destroyed all of them on evidence that was never gathered.
    const decl = gate.match(/const FIELDS = ([^;]+);/);
    assert.ok(decl, "could not find the gate's FIELDS declaration");
    const body = decl[1];

    assert.ok(
      body.includes("INCOME_FIELDS") && body.includes("BALANCE_SHEET_FIELDS"),
      "FIELDS must be DERIVED from the writer's ownership constants, not " +
        `restated. Found: ${body.trim()}`,
    );
    // A literal array would re-open the drift even if it happened to be
    // complete today.
    assert.ok(
      !/["']revenue["']/.test(body),
      "FIELDS must not name fields literally — that is how it drifted",
    );
  });

  it("[meta] the ownership constants are non-empty and cover both statements", () => {
    // Falsifiable ceiling: if both arrays were empty the assertion above would
    // still pass on the spread, proving nothing about coverage.
    assert.ok(INCOME_FIELDS.length >= 4, "INCOME_FIELDS should be non-trivial");
    assert.ok(
      BALANCE_SHEET_FIELDS.length >= 4,
      "BALANCE_SHEET_FIELDS should be non-trivial",
    );
    for (const f of ["totalDebt", "otherIncome"] as const) {
      assert.ok(
        [...INCOME_FIELDS, ...BALANCE_SHEET_FIELDS].includes(f),
        `${f} must be in the owned set — it is the column this test is about`,
      );
    }
  });

  it("both sides derive filerShape from the SAME helper, not a local copy", () => {
    // The parity test above asserts KEY PRESENCE only — MONEY-1250 review — so
    // a gate hard-coding `filerShape: "IND_AS"` would pass it while putting the
    // gate and the writer on different owned sets for every Form-A bank. That
    // is the MONEY-1236 defect with a new field name.
    //
    // There were four copies of this predicate under TWO definitions: a
    // finite-checked `num(v, "bankCapital")` in the projection versus a bare
    // `!== undefined` at the three ownership sites. With `bankCapital: NaN` the
    // projection computed a totalDebt while ownership dropped the column, so the
    // value was silently never written.
    for (const [label, src] of [
      ["writer", writer],
      ["gate", gate],
    ] as const) {
      assert.match(
        src,
        /filerShapeOf\(/,
        `${label} must call the shared filerShapeOf helper`,
      );
      assert.doesNotMatch(
        src,
        /bankCapital\s*!==\s*undefined/,
        `${label} still carries a local copy of the Form-A predicate`,
      );
    }
  });

  it("lenderTopLineShape is NOT used to decide balance-sheet ownership", () => {
    // The collision the review flagged. `lenderTopLineShape` returns the SAME
    // two strings — "RBI_FORM_A" | "IND_AS" — from `tags.revenueFromOperations
    // === "InterestEarned"`, and an NBFC tags `InterestEarned`. So it answers
    // "RBI_FORM_A" for exactly the 665 Ind-AS lender filings whose totalDebt the
    // four-way sum exists to fill. `filerShape: lenderTopLineShape(financials)`
    // is a one-line, entirely plausible refactor that silently drops totalDebt
    // AND totalCash for all 665.
    for (const [label, src] of [
      ["writer", writer],
      ["gate", gate],
    ] as const) {
      assert.doesNotMatch(
        src,
        /filerShape:\s*lenderTopLineShape/,
        `${label} must not feed the INCOME-statement shape into balance-sheet ` +
          `ownership — they disagree on 665 filings`,
      );
    }
  });

  it("[meta] the extractor actually found both objects", () => {
    // A falsifiable ceiling: an extractor that silently returned an empty set
    // would make the assertion above pass by finding nothing to compare.
    assert.ok(
      provenanceKeys(writer, "filingProvenance").size >= 6,
      "writer provenance should have at least 6 fields",
    );
    assert.ok(
      provenanceKeys(gate, "provenance").size >= 5,
      "gate provenance should have at least 5 fields",
    );
  });
});

describe("MONEY-1255 — the two founder decisions must be LOUDER than the verdict", () => {
  /**
   * D2 (declared divergence) and D3 (symbol exclusions) both make the gate stop
   * blocking on something real. Each is one careless edit from becoming a way
   * to turn a red gate green, and the edits that would do it live in
   * `xbrl-reconcile.ts` rather than in the pure helpers — which is why these
   * assertions read the SOURCE. The helpers' own behaviour, including the
   * ordering between the four verdicts, is pinned in
   * `reconcile-declared-divergence.test.ts`.
   */

  it("the verdict ORDERING is delegated, not re-inlined at the call site", () => {
    // It WAS two inline conditions whose precedence lived in the order they
    // were written, and D2 adds a third state to that shape. Three states with
    // an implicit ordering is how the ratios gate became unpassable for a whole
    // release. A future edit that re-inlines the predicate would compile, pass
    // every other test here, and reintroduce the ordering bug silently.
    assert.match(RECONCILE, /judgeFieldGateOutcome\(\{/);
    assert.doesNotMatch(
      RECONCILE,
      /const\s+unverifiable\s*=\s*v\.comparable === 0/,
      "the UNVERIFIABLE predicate is back inline — it belongs in " +
        "judgeFieldGateOutcome, where its ordering against DECLARED and " +
        "BLOCKED is unit-tested",
    );
  });

  it("declares totalDebt, with BOTH the reason and the evidence", () => {
    // A declaration carrying only a reason is an opinion. The split is what
    // makes the printed block auditable, and both strings are printed VERBATIM
    // — a declaration whose evidence lives in a commit message is
    // indistinguishable from a suppression six months later.
    assert.match(RECONCILE, /DECLARED_FIELD_DIVERGENCES/);
    assert.match(RECONCILE, /totalDebt:\s*\{/);
    assert.match(RECONCILE, /reason:/);
    assert.match(RECONCILE, /evidence:/);
  });

  it("the declaration names the ACTUAL four lender concepts", () => {
    // Not decoration. `projectFinancials` sums
    // `borrowings + debtSecurities + deposits + subordinatedLiabilities` for an
    // Ind-AS lender, and a declaration naming a concept the projection does not
    // read would describe a quantity we never compute — which is how a
    // declaration stops being falsifiable. Checked against the projection's own
    // source so the two cannot drift.
    const PROJECTION = strip(
      read("packages/core/src/market-data/xbrl-projection.ts"),
    );
    for (const concept of [
      "borrowings",
      "debtSecurities",
      "deposits",
      "subordinatedLiabilities",
    ]) {
      // WORD-BOUNDARY, not `includes` — mutation-measured. A plain substring
      // test cannot tell `deposits` from `depositsFromCustomers`, and
      // `depositsFromCustomers` is exactly the plausible-but-wrong name a
      // reader reaches for (it is not in the concept map; the tag is
      // `Deposits`). Renaming the concept in the declaration to something the
      // projection never reads left this test green until the boundary was
      // added.
      assert.match(
        RECONCILE,
        new RegExp(`\\b${concept}\\b`),
        `the declaration must name ${concept} exactly — a near-miss name ` +
          `describes a quantity the projection does not compute`,
      );
      assert.ok(
        PROJECTION.includes(`num(v, "${concept}")`),
        `${concept} is named in the declaration but the projection does not ` +
          `read it — the declaration describes a quantity we do not compute`,
      );
    }
  });

  it("the declaration states the null-never-zero rule the sum depends on", () => {
    // `sumPresent` returns undefined when every part is absent rather than
    // folding an empty list to 0. That is the whole reason this gap can be
    // DECLARED instead of blocking: a 0 would be a factual claim of zero debt
    // that a screener ranks on, indistinguishable from a company that has none.
    assert.match(RECONCILE, /sumPresent returns undefined rather than 0/);
  });

  it("a DECLARED field still prints its full census — declaring is not hiding", () => {
    // The single property separating this mechanism from a suppression. The
    // census is emitted by one shared `log.info` for every verdict, so the
    // guard is that DECLARED goes through that same line rather than
    // short-circuiting past it.
    assert.match(RECONCILE, /DECLARED: "DECLARE"/);
    assert.match(
      RECONCILE,
      /comparable \$\{v\.comparable\} of \$\{v\.compared\} judged/,
    );
    assert.match(RECONCILE, /DECLARED DEFINITIONAL DIVERGENCE — NOT GRADED/);
  });

  it("each declared symbol is named WITH a reason, in the gate it blocks", () => {
    // The list itself. A symbol added without a reason is an exclusion nobody
    // can argue with.
    //
    // The list used to be four. CENTUM and DVL block `roe` in the SIBLING
    // ratios gate and contribute no scale row, no sign row and no output line
    // here, so both printed `removed 0 comparison(s)` — which is what the
    // zero-row rule exists to surface, and what moved them. The negatives are
    // asserted alongside the positives because an exclusion declared in the
    // wrong report is invisible in the right one: nothing about the ratios
    // gate's verdict ever mentioned that two symbols were meant to be excluded
    // from it.
    for (const symbol of ["MODIRUBBER", "OPTIEMUS"]) {
      assert.match(
        RECONCILE,
        new RegExp(`\\n  ${symbol}:\\s`),
        `${symbol} must be a keyed entry in EXCLUDED_SYMBOLS, with a reason`,
      );
    }
    for (const symbol of ["CENTUM", "DVL"]) {
      // WORD-BOUNDARY, not `includes` — `DVL` is a substring of nothing here
      // today, but a three-letter ticker is exactly the string that starts
      // matching something unrelated later.
      assert.doesNotMatch(
        RECONCILE,
        new RegExp(`\\b${symbol}\\b`),
        `${symbol} blocks the RATIOS gate, not this one — declaring it here ` +
          `removes nothing and reads as though it were holding this ladder back`,
      );
      assert.match(
        RATIOS,
        new RegExp(`\\n  ${symbol}:\\s`),
        `${symbol} must be a keyed entry in the ratios gate's EXCLUDED_SYMBOLS`,
      );
    }
  });

  it("the symbol tally is seeded from the DECLARATION, never from the rows", () => {
    // The property that surfaces an exclusion which removed nothing — the
    // property that found CENTUM and DVL sitting in this file's list on the
    // prod run of 2026-08-26. Seed from the rows instead and a symbol that
    // removes nothing silently vanishes from the report while looking as
    // load-bearing as the ones that matter.
    //
    // Asserted on BOTH gates: they share the helper precisely so an exclusion
    // has to justify itself against its own population, and a second gate that
    // hand-rolled the tally would be free to drop the zero rows.
    assert.match(
      RECONCILE,
      /tallySymbolExclusions\(\s*symbolExcludedRows,\s*Object\.keys\(EXCLUDED_SYMBOLS\)/,
    );
    assert.match(RECONCILE, /REMOVED NOTHING/);
    // The SECOND ARGUMENT of the CALL, not "the file mentions
    // Object.keys(EXCLUDED_SYMBOLS) somewhere" — mutation-measured. That looser
    // form SURVIVED a mutation which reseeded the tally from
    // `symbolExcluded.map(j => j.symbol)`, because `EXCLUDED_SYMBOL_SET` is
    // built from `Object.keys(EXCLUDED_SYMBOLS)` twenty lines away and the
    // substring was still there. Seeding from the rows is the whole defect:
    // every zero-removal symbol disappears from the report.
    assert.match(
      RATIOS,
      /tallySymbolExclusions\([\s\S]{0,600}?\n\s*Object\.keys\(EXCLUDED_SYMBOLS\),\n\s*\);/,
      "the ratios tally must be seeded from the declared list, not the rows",
    );
    assert.match(RATIOS, /REMOVED NOTHING/);
  });

  it("the ratios gate EXCLUDES the symbols rather than declaring their ratio", () => {
    // The instrument choice, pinned. `DECLARED_DIVERGENCES` there is keyed by
    // RATIO and removes the whole ratio from the verdict; `roe` is the only
    // ratio with real vendor coverage (2,038 of 2,135 rows against 0/86/85/86),
    // so declaring it would leave the gate passing on four UNVERIFIABLE lines —
    // MONEY-1237's self-comparison trap reached from the other side.
    assert.doesNotMatch(
      RATIOS,
      /DECLARED_DIVERGENCES[\s\S]{0,4000}?\n {2}roe:/,
      "roe must NOT be a declared divergence — it is the only graded ratio",
    );
    // …and the exclusion must actually narrow the graded population. A list
    // nothing reads is the silent-exclusion failure in its purest form.
    assert.match(RATIOS, /EXCLUDED_SYMBOL_SET\.has\(/);
    assert.match(
      RATIOS,
      /const graded = judgements\.filter\(\s*\(j\) => !EXCLUDED_SYMBOL_SET\.has\(j\.symbol\)/,
    );
    assert.match(
      RATIOS,
      /const rows = graded\.filter\(/,
      "the per-ratio census must be computed over the GRADED population",
    );
  });

  it("an excluded symbol's numbers are still PRINTED — the evidence stays", () => {
    // Same rule the DECLARED ratios follow in that file: the offending pairs
    // sort last and are labelled rather than dropped, because those numbers are
    // the evidence the exclusion rests on. Removing CENTUM's
    // `xbrl=-0.652 tickertape=+0.833` from the only place it is visible would
    // make the entry unfalsifiable by the next reader.
    assert.match(RATIOS, /NOT GRADED — symbol excluded/);
    assert.match(RATIOS, /isSymbolExcluded\(/);
    // Over `judgements`, NOT `graded` — filtering the worst-offenders list to
    // the graded population is exactly how the evidence would disappear.
    assert.match(RATIOS, /const worst = judgements\b/);
  });

  it("says a symbol exclusion is NOT like the others — the writer still writes it", () => {
    // The distinction the whole of D3 turns on. Every other exclusion in that
    // file removes a row because the WRITER WILL NOT WRITE IT, which is what
    // keeps the gate a measurement of the writer. These rows get written
    // anyway. A report filing them beside the others tells the reader the gate
    // got more accurate when it in fact got more permissive.
    assert.match(RECONCILE, /THESE ARE NOT LIKE THE OTHER EXCLUSIONS/);
    assert.match(RECONCILE, /rows WILL be written/);
  });

  it("INCUMBENT-NULLING is keyed on the WRITER's skip, not on the ladder's", () => {
    // The defect D3 could most easily have introduced. `nullsIncumbent` counts
    // pairs where arming REPLACES a populated vendor value with NULL. A
    // symbol-excluded row is still written, so it still destroys that value —
    // keying the count on `excluded` would have stopped counting incumbent
    // destruction for exactly the four symbols already known to be wrong, in
    // the one block that exists because the ladder cannot see this class.
    const nulling = /const nullsIncumbent =[\s\S]{0,400}?;/.exec(RECONCILE);
    assert.ok(nulling, "nullsIncumbent computation not found");
    assert.match(nulling[0], /writerSkip === undefined/);
    assert.doesNotMatch(nulling[0], /\bexcluded === undefined/);
  });

  it("the exclusion DRAIN cannot be tripped by a declared field", () => {
    // The drain withdraws READY when exclusions removed half a field's
    // comparable pairs. A DECLARED field has no READY to withdraw — it is not
    // graded — so draining one would block the switchover on a field the run
    // deliberately makes no claim about. Guarded on the OUTCOME, not on
    // `v.ready`, which is still true for a declared field that happens to
    // clear the ladder.
    assert.match(
      RECONCILE,
      /if \(outcome\.verdict === "READY" && share >= EXCLUSION_DRAIN_FLOOR\)/,
    );
  });

  it("both decisions travel with the VERDICT line, not only in a block above it", () => {
    // MONEY-1237's contamination lesson and MONEY-1239's nulling note applied a
    // third time: a disclosure hundreds of lines earlier is inert because the
    // reader reads the verdict. Each note must be DEFINED once and appended to
    // BOTH branches — a READY that omitted them is precisely the misreading to
    // prevent — so three occurrences is the floor.
    assert.ok(
      /VERDICT: every field is READY/.test(RECONCILE) &&
        /VERDICT: NOT ready over/.test(RECONCILE),
      "both verdict branches should be present",
    );
    assert.ok(
      (RECONCILE.match(/symbolNote/g) ?? []).length >= 3,
      "symbolNote must be defined and appended to BOTH verdict branches",
    );
    assert.ok(
      (RECONCILE.match(/declaredNote/g) ?? []).length >= 3,
      "declaredNote must be defined and appended to BOTH verdict branches",
    );
  });

  it("prints the UNOWNED vendor columns rather than restating them", () => {
    // What a READY verdict does NOT cover. `revenue`, `operatingIncome` and
    // `ebitda` are absent from the ladder entirely — not blocked, not exempted,
    // simply never written — and nothing else in the report would tell a reader
    // that the vendor's `revenue` survives the switchover untouched. Imported
    // and printed, because a second copy of that reasoning is a copy that
    // drifts.
    assert.match(RECONCILE, /UNOWNED_VENDOR_COLUMNS/);
    assert.match(RECONCILE, /VENDOR COLUMNS THE PROJECTION DOES NOT OWN/);
  });

  it("[meta] the source was actually loaded — a blank read passes the negatives", () => {
    // Every assertion above is over one string. An empty `RECONCILE` fails the
    // `match`es but PASSES every `doesNotMatch`, so the negative assertions
    // specifically need this floor.
    assert.ok(
      RECONCILE.length > 50_000,
      `reconcile source read as ${RECONCILE.length} chars`,
    );
    assert.match(RECONCILE, /judgeSwitchoverReadiness/);
  });
});
