/**
 * The per-SHEET gate: a parsed sheet is not automatically a written one.
 * MONEY-1404 C3 (consume `anomalies`) + MONEY-1405 D1 (a 200 is not freshness).
 *
 * ## The two defects
 *
 * **C3.** `checkPercentSum` computes a `scale-suspect` verdict, `parseSheet`
 * pushes it into `AmcSchemeSheet.anomalies`, and `grep -n anomal
 * workers/src/processors/mf-portfolio-sync.ts` returned NOTHING — every row was
 * upserted whatever the verdict said. MONEY-1238 moved that check from "read by
 * nobody" to "read by nobody ONE LEVEL UP", which is the same defect with a
 * longer call chain.
 *
 * **D1.** Nothing in the job asked what MONTH a file describes. Two live
 * sources punish that and both answer 200 with a real, fully-parsable workbook:
 * Axis's undated `IN_MF_MONTHLY_PORTFOLIO_AXISMF.xls` (59 sheets, every one
 * "as on January 31, 2022") and KFintech's unauthenticated per-scheme store
 * (frozen; as-on dates sampled across Sep-2021, Jun-2024 and Aug-2025).
 *
 * ## Why the status precedence is asserted as hard as the gate
 *
 * A wholly-stale house has sheets AND holdings and writes nothing, so without a
 * refusal branch ahead of `sheets > 0` it reports `PARSED_BUT_NOTHING_WRITTEN`
 * — which names `schemeKeyOf` and the write path, i.e. sends the investigation
 * to the one part that is working. That is MONEY-1236's lesson (`FETCH_FAILED`
 * standing in for a parse fault) arriving one ticket later.
 *
 * LINE comments are stripped before BLOCK comments (MONEY-1143): this
 * processor's own comments quote the code the wiring assertions forbid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  judgeAmcAttempt,
  judgeSheetWrite,
} from "../../src/processors/mf-portfolio-sync-logic";
import { schemeMatchKeyOf, schemeKeyOf } from "../../src/processors/mf-portfolio-sync";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "mf-portfolio-sync.ts"),
  "utf8",
);
const CODE = blankComments(RAW);

/**
 * The body of the `{ … }` block that follows `header`, brace-matched.
 *
 * WHY THIS EXISTS — MONEY-1401. Two cases below grepped the WHOLE file for a
 * token that the whole file is full of, and both were vacuous: a bare
 * `assert.match(CODE, /continue;/)` is satisfied by any of this processor's
 * fifteen-odd `continue` statements, so deleting the refusal gate's OWN
 * `continue` — which makes a REFUSED sheet fall through and get written, i.e.
 * the exact defect the case is named for — left it green. Verified by running
 * that mutation.
 *
 * Scoping to the statement a case actually means is the fix, the same way
 * `bashArrayBody` scopes to an array's body rather than grepping a script.
 * Throws rather than returning "" when the header is gone: an empty haystack
 * makes every `doesNotMatch` pass and every `match` fail for the wrong reason.
 */
function blockAfter(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`blockAfter: header not found: ${header}`);
  const open = src.indexOf("{", at + header.length);
  if (open < 0) throw new Error(`blockAfter: no block after: ${header}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`blockAfter: unbalanced braces after: ${header}`);
}

/** A healthy sheet for the month under test. */
const healthy = {
  asOfDate: "2026-08-31",
  percentSumCheck: { verdict: "ok" },
  missingColumns: [] as string[],
};

describe("judgeSheetWrite: the month must match (MONEY-1405 D1)", () => {
  it("writes a sheet whose as-on month is the requested one", () => {
    const v = judgeSheetWrite(healthy, "2026-08");
    assert.equal(v.write, true);
    assert.equal(v.refusal, null);
    assert.equal(v.detail, null);
  });

  it("the DAY is not compared, only the month", () => {
    // AMCs publish on the last day of the month, but a 30/31/28 comparison
    // would be a leap-year bug waiting to happen and some houses stamp the 1st.
    //
    // MUTATION: compare `sheet.asOfDate` to `requestedMonth` whole -> every
    // sheet becomes STALE_FILE. RED (this and every write case below).
    assert.equal(
      judgeSheetWrite({ ...healthy, asOfDate: "2026-08-01" }, "2026-08").write,
      true,
    );
    assert.equal(
      judgeSheetWrite({ ...healthy, asOfDate: "2026-08-31" }, "2026-08").write,
      true,
    );
  });

  it("REGRESSION: Axis's January-2022 workbook is REFUSED", () => {
    // The exact shape: fetch ok, parse ok, holdings real, date four years old.
    //
    // MUTATION: `return { write: true, … }` in the STALE_FILE branch -> the
    // 2022 holdings are written over August. RED.
    const v = judgeSheetWrite({ ...healthy, asOfDate: "2022-01-31" }, "2026-08");
    assert.equal(v.write, false);
    assert.equal(v.refusal, "STALE_FILE");
  });

  it("the refusal NAMES BOTH dates", () => {
    // "stale" on its own is a claim the operator has to go and verify by hand,
    // against a URL that answers 200 — which is how this went unnoticed.
    //
    // MUTATION: drop `${requestedMonth}` from the detail string -> RED.
    const v = judgeSheetWrite({ ...healthy, asOfDate: "2022-01-31" }, "2026-08");
    assert.ok(v.detail, "a refusal must carry prose");
    assert.match(v.detail, /2022-01-31/, "the file's own date");
    assert.match(v.detail, /2026-08/, "the month that was requested");
  });

  it("KFintech's frozen months are each refused on their own date", () => {
    // One frozen file per scheme, so the refusals differ per scheme rather than
    // per house — sampled Sep-2021, Jun-2024, Aug-2025 against a 2026-08 run.
    for (const asOfDate of ["2021-09-30", "2024-06-30", "2025-08-31"]) {
      const v = judgeSheetWrite({ ...healthy, asOfDate }, "2026-08");
      assert.equal(v.write, false, asOfDate);
      assert.equal(v.refusal, "STALE_FILE", asOfDate);
      assert.match(v.detail!, new RegExp(asOfDate));
    }
  });

  it("a FUTURE month is refused too, not just an old one", () => {
    // `!==`, not `<`. A file stamped ahead of the requested month is equally
    // not the month that was asked for, and a one-sided comparison would write
    // it — which is how an off-by-one in the run's own month resolution would
    // silently overwrite a good period.
    //
    // MUTATION: `asOnMonth < requestedMonth` -> this case writes. RED.
    const v = judgeSheetWrite({ ...healthy, asOfDate: "2026-09-30" }, "2026-08");
    assert.equal(v.write, false);
    assert.equal(v.refusal, "STALE_FILE");
  });

  it("NO as-on date at all is its own refusal, never a pass", () => {
    // Distinct from STALE_FILE on purpose: an unreadable date sends you to the
    // PARSER, an old one to the SCHEDULE or the URL. And it must not be
    // optimistic — "we could not tell" is not "it is current".
    //
    // MUTATION: `if (sheet.asOfDate === null) return { write: true, … }` ->
    // every sheet whose header moved is written as if current. RED.
    const v = judgeSheetWrite({ ...healthy, asOfDate: null }, "2026-08");
    assert.equal(v.write, false);
    assert.equal(v.refusal, "NO_AS_ON");
    assert.match(v.detail!, /2026-08/);
  });
});

describe("judgeSheetWrite: the scale verdict DECIDES (MONEY-1404 C3)", () => {
  it("REGRESSION: a scale-suspect sheet is refused", () => {
    // `checkPercentSum` had computed this on every sheet since MONEY-1238 and
    // the processor never read it. A 100x percent/fraction misread puts every
    // pctToNav on the sheet off by that factor and nothing throws.
    //
    // MUTATION: delete the scale-suspect branch -> `write` is true. RED.
    const v = judgeSheetWrite(
      { ...healthy, percentSumCheck: { verdict: "scale-suspect" } },
      "2026-08",
    );
    assert.equal(v.write, false);
    assert.equal(v.refusal, "SCALE_SUSPECT");
  });

  it("`uncheckable` is NOT a refusal", () => {
    // It means the sheet lacked an input for the comparison (no GRAND TOTAL
    // line), which is an ABSENT check rather than a failed one. Refusing on it
    // would discard every scheme whose workbook omits an AUM.
    //
    // MUTATION: refuse on anything that is not "ok" -> this goes RED, and the
    // job silently stops storing a whole class of scheme.
    assert.equal(
      judgeSheetWrite(
        { ...healthy, percentSumCheck: { verdict: "uncheckable" } },
        "2026-08",
      ).write,
      true,
    );
  });

  it("the STALE check outranks the scale check", () => {
    // A four-year-old sheet with a bad percent column is stale first: fixing
    // the scale would still leave the wrong month, and the operator needs the
    // reason that makes the other one moot.
    //
    // MUTATION: move the scale-suspect branch above the as-on branch -> the
    // refusal reads SCALE_SUSPECT and the 2022 date never surfaces. RED.
    const v = judgeSheetWrite(
      {
        asOfDate: "2022-01-31",
        percentSumCheck: { verdict: "scale-suspect" },
        missingColumns: [],
      },
      "2026-08",
    );
    assert.equal(v.refusal, "STALE_FILE");
  });
});

describe("judgeSheetWrite: missingColumns is COUNTED, not refused", () => {
  it("a sheet missing a column still writes, and says so", () => {
    // The parser nulls those fields rather than defaulting them to zero, so the
    // rows are honest and incomplete rather than wrong — and refusing them
    // would discard a whole AMC over one dropped column.
    //
    // MUTATION: `if (missingColumns) return { write: false, … }` -> RED, and
    // the job stops storing any house that drops `quantity`.
    const v = judgeSheetWrite({ ...healthy, missingColumns: ["quantity"] }, "2026-08");
    assert.equal(v.write, true);
    assert.equal(v.missingColumns, true);
  });

  it("it is orthogonal to a refusal, not folded into one", () => {
    // A refused sheet still reports whether it was also short a column: the two
    // answer different questions and collapsing them loses the second.
    //
    // MUTATION: return `missingColumns: false` from the STALE_FILE branch ->
    // RED.
    const v = judgeSheetWrite(
      { ...healthy, asOfDate: "2022-01-31", missingColumns: ["isin"] },
      "2026-08",
    );
    assert.equal(v.refusal, "STALE_FILE");
    assert.equal(v.missingColumns, true);
  });

  it("a clean sheet reports false", () => {
    assert.equal(judgeSheetWrite(healthy, "2026-08").missingColumns, false);
  });
});

describe("judgeAmcAttempt: a refused house has its OWN status", () => {
  it("REGRESSION: a wholly-stale house is not PARSED_BUT_NOTHING_WRITTEN", () => {
    // It has 59 sheets and thousands of holdings and writes nothing, so without
    // the refusal branch AHEAD of `sheets > 0` the status names `schemeKeyOf`
    // and the write path — the one part that is working.
    //
    // MUTATION: move the `refused > 0` branch below the `sheets > 0` branch ->
    // status becomes PARSED_BUT_NOTHING_WRITTEN. RED.
    const v = judgeAmcAttempt({ parsedOk: true,
      sheets: 59,
      holdings: 3100,
      written: 0,
      stale: 59,
      refusalExample: "file is as on 2022-01-31 but 2026-08 was requested",
    });
    assert.equal(v.ok, false);
    assert.match(v.status, /^STALE_FILE /);
    assert.match(v.status, /59 sheet\(s\) refused/);
    assert.match(v.status, /2022-01-31/, "the example must survive into status");
    assert.match(v.status, /2026-08/);
  });

  it("names the DOMINANT refusal when a house has several", () => {
    // MUTATION: always report STALE_FILE -> RED on both of these.
    assert.match(
      judgeAmcAttempt({ parsedOk: true, sheets: 9, holdings: 90, written: 0, noAsOn: 7, stale: 2 })
        .status,
      /^NO_AS_ON /,
    );
    assert.match(
      judgeAmcAttempt({ parsedOk: true,
        sheets: 9,
        holdings: 90,
        written: 0,
        scaleSuspect: 7,
        noAsOn: 1,
      }).status,
      /^SCALE_SUSPECT /,
    );
  });

  it("a PARTIALLY stale house stays ok and says how much it lost", () => {
    // Half a month is still a month: refusing the whole house would discard the
    // schemes that ARE current. But it must not read as a clean OK.
    //
    // MUTATION: leave the refusal counters out of the OK_PARTIAL parts ->
    // status is a bare "OK". RED.
    const v = judgeAmcAttempt({ parsedOk: true,
      sheets: 10,
      holdings: 500,
      written: 250,
      stale: 5,
      scaleSuspect: 1,
    });
    assert.equal(v.ok, true);
    assert.match(v.status, /^OK_PARTIAL /);
    assert.match(v.status, /5 stale/);
    assert.match(v.status, /1 scale-suspect/);
  });

  it("REGRESSION: the pre-MONEY-1404 statuses are byte-identical", () => {
    // Nothing reading these has to relearn a vocabulary, and a clean house must
    // still read exactly "OK" — HDFC's status line concatenates onto it.
    //
    // MUTATION: emit `OK_PARTIAL ()` when nothing was refused -> RED.
    assert.deepEqual(judgeAmcAttempt({ parsedOk: true, sheets: 12, holdings: 640, written: 640 }), {
      ok: true,
      status: "OK",
    });
    assert.equal(
      judgeAmcAttempt({ parsedOk: true, sheets: 12, holdings: 640, written: 640, fetchFailed: 1 })
        .status,
      "OK_PARTIAL (1 fetch-failed)",
    );
    assert.equal(
      judgeAmcAttempt({ parsedOk: true,
        sheets: 12,
        holdings: 640,
        written: 640,
        fetchFailed: 1,
        unrecognised: 2,
      }).status,
      "OK_PARTIAL (1 fetch-failed, 2 unrecognised)",
    );
    assert.equal(
      judgeAmcAttempt({ parsedOk: true, sheets: 12, holdings: 0, written: 0 }).status,
      "PARSED_BUT_NO_HOLDINGS",
    );
    assert.equal(
      judgeAmcAttempt({ parsedOk: true, sheets: 12, holdings: 640, written: 0 }).status,
      "PARSED_BUT_NOTHING_WRITTEN",
    );
  });

  it("`written > 0` still outranks everything", () => {
    // A house that stored rows is ok however many of its sheets were refused.
    assert.equal(
      judgeAmcAttempt({ parsedOk: true, sheets: 60, holdings: 3000, written: 5, stale: 59 }).ok,
      true,
    );
  });
});

describe("schemeMatchKeyOf: the second scheme resolver's key (MONEY-1404 C5)", () => {
  it("strips the SEBI category sentence the AMC sheet appends", () => {
    // Measured on prod: keying on `schemeKeyOf` alone left 344 of 662 schemes
    // with NO master candidate, and this is the single biggest cause.
    //
    // MUTATION: drop the trailing-parenthetical replace -> the two sides stop
    // agreeing. RED.
    assert.equal(
      schemeMatchKeyOf(
        "HDFC Nifty Metal ETF (An open ended scheme replicating/tracking Nifty Metal Index (TRI))",
      ),
      schemeMatchKeyOf("HDFC Nifty Metal ETF"),
    );
    assert.equal(schemeMatchKeyOf("HDFC Nifty Metal ETF"), "hdfc-nifty-metal-etf");
  });

  it("strips Groww's internal `IB13-` prefix", () => {
    // MUTATION: drop the prefix replace -> RED.
    assert.equal(schemeMatchKeyOf("IB13-Groww Value Fund"), schemeMatchKeyOf("Groww Value Fund"));
  });

  it("keeps a MID-name parenthetical, which is part of the identity", () => {
    // `SBI Fixed Maturity Plan (FMP)- Series 51` and `… Series 52` are
    // different schemes. A greedy strip would make them one key, one ambiguity
    // and two funds with no code.
    //
    // MUTATION: use /\([^)]*\)/g (no `$` anchor) -> these collapse. RED.
    assert.notEqual(
      schemeMatchKeyOf("SBI Fixed Maturity Plan (FMP)- Series 51"),
      schemeMatchKeyOf("SBI Fixed Maturity Plan (FMP)- Series 52"),
    );
    assert.match(schemeMatchKeyOf("SBI Fixed Maturity Plan (FMP)- Series 51"), /fmp/);
  });

  it("is BUILT ON schemeKeyOf, so both sides normalise identically", () => {
    // The storage key strips plan/option words; the match key must too, or a
    // sheet's `HDFC Value Fund` never meets a master's `HDFC Value Fund -
    // Direct Plan - Growth Option`.
    //
    // MUTATION: stop calling schemeKeyOf inside schemeMatchKeyOf -> RED.
    assert.equal(
      schemeMatchKeyOf("HDFC Value Fund - Direct Plan - Growth Option"),
      schemeKeyOf("HDFC Value Fund"),
    );
  });

  it("does not eat a name that merely starts with letters and digits", () => {
    // The prefix pattern needs UPPERCASE letters, digits and a hyphen. A fund
    // named `360 ONE Focused Equity Fund` must survive intact.
    assert.match(schemeMatchKeyOf("360 ONE Focused Equity Fund"), /^360-one/);
  });
});

describe("WIRED: the gate is on the path, not beside it (MONEY-1404/1405)", () => {
  it("[meta] the source this file reasons over actually loaded", () => {
    assert.ok(RAW.length > 5000, `mf-portfolio-sync.ts did not load (${RAW.length}B)`);
    assert.ok(CODE.includes("processMfPortfolioSync"), "the stripper ate the code");
  });

  it("REGRESSION: `writeSheet` has exactly ONE caller, and it is the gate", () => {
    // The defect this closes is a check that existed and was applied nowhere.
    // Three hand-copied sheet loops is how the fourth site gets written without
    // one, so the three sites now share `writeSheets` and `writeSheet` is
    // reachable only through it.
    //
    // MUTATION: re-add a direct `writeSheet(` call in any loop -> both counts
    // go up by one. RED.
    const calls = CODE.match(/await writeSheet\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      `writeSheet must be called only from writeSheets; found ${calls.length}`,
    );
    // The declaration plus that one call — so an UNAWAITED call (which would
    // also drop the returned count) cannot slip past the line above.
    assert.equal((CODE.match(/writeSheet\(/g) ?? []).length, 2);
    assert.match(CODE, /await writeSheet\(amc, amcFundName, sheet, sourceUrl, ctx\)/);
  });

  it("all three sites go through writeSheets", () => {
    const calls = CODE.match(/await writeSheets\(/g) ?? [];
    assert.equal(
      calls.length,
      3,
      `expected the template loop, the page-scrape loop and HDFC; found ${calls.length}`,
    );
  });

  it("the gate is consulted, and its answer SKIPS the write", () => {
    // MUTATION: delete the `if (!verdict.write) { … continue; }` block -> RED.
    // MUTATION: delete ONLY that block's `continue;`, leaving the counters and
    //   the log in place, so a refused sheet is counted, logged AND written
    //   -> RED. It was GREEN before MONEY-1401: the old form matched
    //   `/continue;/` against the whole file, and this processor has many.
    assert.match(CODE, /judgeSheetWrite\(sheet, ctx\.periodLabel\)/);
    const gate = blockAfter(CODE, "if (!verdict.write)");
    assert.match(
      gate,
      /\bcontinue;\s*$/,
      "the refusal branch must END in `continue;` — counting and logging a " +
        "refused sheet and then falling through into writeSheet is the " +
        "defect this gate exists to prevent, and it reads as working",
    );
    // The branch must not be able to reach the write by any other door either.
    assert.doesNotMatch(gate, /writeSheet\(/);
    // And the write must sit AFTER the gate, not before it: a gate consulted
    // downstream of the thing it gates is decoration.
    assert.ok(
      CODE.indexOf("if (!verdict.write)") <
        CODE.indexOf("await writeSheet(amc, amcFundName, sheet, sourceUrl, ctx)"),
      "the refusal branch must precede the write it guards",
    );
  });

  it("the refusal counters reach reportJobOutcome", () => {
    // `[job-outcome]` prints `skippedReason`, and "why was less written than
    // the sheets suggest" is exactly what it is for. MONEY-1238's whole point
    // is that a counter nobody reads is not a check.
    //
    // MUTATION: drop `reasons` from the reportJobOutcome call -> RED.
    // MUTATION: neuter the refusal push (`if (refusedTotal > 0)` ->
    //   `if (false)`), so refusals are COUNTED and never reported -> RED.
    //   It was GREEN before MONEY-1401: `assert.match(CODE, /out\.refused/)`
    //   proved only that the identifier appears somewhere in the file, and
    //   `absorb` mentions it whether or not anything reads it back out.
    assert.match(CODE, /reportJobOutcome\(\{[\s\S]*?skippedReason: reasons\.join/);

    // The whole chain, named at each hop, because a break at ANY of them
    // produces the same silent skip: tally -> out.refused -> refusedTotal ->
    // reasons -> skippedReason.
    assert.match(
      CODE,
      /const \{ stale, noAsOn, scaleSuspect, missingColumns \} = out\.refused;/,
      "the run totals must be read back out of out.refused",
    );
    assert.match(
      CODE,
      /const refusedTotal = stale \+ noAsOn \+ scaleSuspect;/,
      "all three refusal reasons must be in the total — a reason left out is " +
        "a refusal nothing reports",
    );
    const push = blockAfter(CODE, "if (refusedTotal > 0)");
    assert.match(push, /reasons\.push\(/);
    // NUMBERS, not an adjective. "some sheets were refused" cannot tell a
    // one-off from a whole house whose column moved.
    for (const counter of ["refusedTotal", "stale", "noAsOn", "scaleSuspect"]) {
      assert.ok(
        push.includes(`\${${counter}}`),
        `the refusal reason must interpolate ${counter}`,
      );
    }
    // Counted but NEVER refused — a separate reason, and separately gated.
    assert.match(blockAfter(CODE, "if (missingColumns > 0)"), /reasons\.push\(/);
  });

  it("the SECOND scheme resolver is wired, and never guesses", () => {
    // MUTATION: take `[...codes][0]` without the `codes.size === 1` test ->
    // one fund's holdings are attributed to another plan's code. RED.
    assert.match(CODE, /buildMasterSchemeIndexOrNull\(\)/);
    assert.match(CODE, /codes\.size === 1/);
    assert.match(CODE, /resolution\.ambiguous\+\+/);
  });
});
