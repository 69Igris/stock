/**
 * Balance-sheet ratios must be derived from the ANNUAL filing — MONEY-1401.
 *
 * ## The defect
 *
 * `deriveOne` passed `latestFinancials` — the newest filing of ANY period type
 * — to `deriveRatios`, and separately told `planRatiosWrite` about
 * `latest.periodType`. Measured on prod 2026-09-13, the newest filing is
 * QUARTERLY for **2,504 of 2,607 symbols (96.0%)**, and 2,365 of those have an
 * annual sitting right there, already loaded twelve lines above and already
 * trusted for exactly this kind of read further down (`xbrl-ratios.ts`
 * `:1574-1577` takes the valuation's equity, debt and cash off it).
 *
 * So arming `XBRL_RATIOS_APPLY` would have replaced a vendor table that fills
 * `roe` on 95.5% and `roce` on 99.2% of rows with one that fills them on ~4%.
 * Fresh, and empty, on the two columns a reader looks at first. No agreement
 * rung in the gate could see it, because fill rate is an OUTCOME and every rung
 * measured agreement among rows that already exist on both sides.
 *
 * ## The mechanism, stated precisely
 *
 * A quarterly filing does not carry no balance sheet — `projectFinancials`
 * always returns a `balanceSheet` OBJECT. What varies is whether its FIELDS are
 * populated, and the fixtures below are the evidence either way rather than an
 * assertion about SEBI:
 *
 *   CIPLA Q3FY26        totalAssets absent  -> no roe/roa/roce
 *   GLAXO Q2FY25        totalAssets present -> all three derived
 *
 * GLAXO's is a HALF-YEAR filing, which does require a balance sheet. So the
 * quarterly is a coin flip and the annual is a guarantee; prod says the coin
 * lands "no" on 657 of ~662 plans built. And even GLAXO's populated quarterly
 * would not have been WRITTEN, because `planRatiosWrite` refused the same
 * columns a second time for being non-annual.
 *
 * ## Why the decision is a function
 *
 * It has to be made once and read twice — by `deriveRatios` and by
 * `planRatiosWrite`, 200 lines apart. Those were two separate expressions, and
 * their disagreement IS this ticket. A source scan cannot police that: it can
 * prove a call site exists, never which of two near-identical arguments is in
 * it. Hence `chooseRatioDerivationInputs`, tested directly here.
 *
 * Fixtures are REAL filings, parsed by the real parser, run through the real
 * `deriveRatios` and the real `planRatiosWrite`. Nothing is stubbed, so the
 * composition below is the one production runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  deriveRatios,
  parseXbrlFinancials,
  planRatiosWrite,
  projectFinancials,
  type XbrlFinancials,
} from "@usemoney/core/market-data";

import { chooseRatioDerivationInputs } from "../../src/processors/xbrl-ratios-logic";

/** Real committed filings, parsed by the real parser. */
function filing(name: string): XbrlFinancials {
  const xml = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "core",
      "__tests__",
      "fixtures",
      "xbrl",
      name,
    ),
    "utf8",
  );
  const parsed = parseXbrlFinancials(xml);
  assert.ok(parsed !== null, `premise: ${name} must parse`);
  return parsed;
}

/** Q3 — carries NO balance-sheet figures. Stands in for the 96% case. */
const QUARTERLY = filing("cipla-q3fy26-standalone-indas-2025-01-31.xml");
/** Half-year — DOES carry them. Stands in for the annual. */
const WITH_BALANCE_SHEET = filing(
  "glaxo-q2fy25-standalone-indas-2020-03-31.xml",
);

/** An empty valuation — this suite is about the balance-sheet columns only. */
const NO_VALUATION = {} as Parameters<typeof planRatiosWrite>[1];

describe("MONEY-1401 — the premise, verified against real filings", () => {
  it("the quarterly fixture genuinely has no balance-sheet figures", () => {
    // If this ever fails, the fixture changed and every case below is testing
    // something other than what it claims to test.
    const p = projectFinancials(QUARTERLY);
    assert.equal(
      p.balanceSheet?.totalAssets,
      undefined,
      "premise: CIPLA Q3FY26 carries no totalAssets",
    );
    const r = deriveRatios(QUARTERLY);
    assert.equal(r.roe, undefined);
    assert.equal(r.roa, undefined);
    assert.equal(r.roce, undefined);
  });

  it("the annual-stand-in fixture genuinely has them", () => {
    const p = projectFinancials(WITH_BALANCE_SHEET);
    assert.ok(
      typeof p.balanceSheet?.totalAssets === "number",
      "premise: GLAXO Q2FY25 carries totalAssets",
    );
    const r = deriveRatios(WITH_BALANCE_SHEET);
    assert.ok(typeof r.roe === "number");
    assert.ok(typeof r.roa === "number");
    assert.ok(typeof r.roce === "number");
  });
});

describe("chooseRatioDerivationInputs", () => {
  it("prefers the ANNUAL when the newest filing is quarterly", () => {
    // MUT: return `latestFinancials` unconditionally -> financials is the
    // quarterly and `usedAnnual` is false -> red.
    const choice = chooseRatioDerivationInputs({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: WITH_BALANCE_SHEET,
      latestAnnualPeriodType: "ANNUAL",
    });
    assert.equal(choice.financials, WITH_BALANCE_SHEET);
    assert.equal(choice.periodType, "ANNUAL");
    assert.equal(choice.usedAnnual, true);
  });

  it("falls back to the newest filing when there is NO annual", () => {
    // The 139 symbols on prod with no annual at all. The planner's existing
    // refusal is correct for them and must stay reachable.
    const choice = chooseRatioDerivationInputs({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: undefined,
      latestAnnualPeriodType: undefined,
    });
    assert.equal(choice.financials, QUARTERLY);
    assert.equal(choice.periodType, "QUARTERLY");
    assert.equal(choice.usedAnnual, false);
  });

  it("reports the ANNUAL row's OWN period type, never a hardcoded one", () => {
    // MUT: `periodType: "ANNUAL"` when usedAnnual -> red. The annual winners
    // come from a set FILTERED to annuals; if that filter ever widens, this
    // must not launder the widening into a false claim.
    const choice = chooseRatioDerivationInputs({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: WITH_BALANCE_SHEET,
      latestAnnualPeriodType: "HALF_YEARLY",
    });
    assert.equal(choice.financials, WITH_BALANCE_SHEET);
    assert.equal(
      choice.periodType,
      "QUARTERLY",
      "a non-annual row must not be reported as ANNUAL",
    );
  });

  it("treats an UNREADABLE annual as absent, not as an empty annual", () => {
    // `readFacts` answers null for an annual whose facts will not parse; the
    // caller coerces that to undefined. Same fallback as no annual at all.
    const choice = chooseRatioDerivationInputs({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: undefined,
      latestAnnualPeriodType: "ANNUAL",
    });
    assert.equal(choice.financials, QUARTERLY);
    assert.equal(choice.usedAnnual, false);
  });
});

describe("the composition production runs: choose -> derive -> plan", () => {
  /**
   * The composition `deriveOne` performs, RE-STATED here — and that is the
   * limit of what this block can prove (MONEY-1401).
   *
   * It is NOT "exactly what `deriveOne` does", which is what this comment used
   * to claim. Two things are true of a hand-written copy of a call site:
   *
   *   - it already DIFFERS. `deriveOne` passes its `extended` history/price
   *     columns to `planRatiosWrite`; this passes `undefined`. Harmless for the
   *     three filing-derived columns below, and it is the shape of the problem.
   *   - it cannot see a change to the thing it copies. Verified by mutation on
   *     2026-09-13: reverting `deriveOne`'s call site to the pre-MONEY-1401
   *     quarterly inputs left every case in this FILE green, and every other
   *     xbrl-ratios case in both workspaces with it.
   *
   * The CALL SITE is asserted in `xbrl-ratios-rotation.test.ts`, under "the
   * ANNUAL reaches the WRITE", which drives the real `processXbrlRatios` and
   * reads the row it upserts. This block keeps its value as a unit test of the
   * composition itself — which inputs produce which columns — and should be
   * read as that and not as coverage of the processor.
   */
  function planFor(args: {
    latestFinancials: XbrlFinancials;
    latestPeriodType: string;
    latestAnnualFinancials: XbrlFinancials | undefined;
    latestAnnualPeriodType: string | undefined;
  }) {
    const derivation = chooseRatioDerivationInputs(args);
    const ratios = deriveRatios(derivation.financials, undefined);
    return planRatiosWrite(
      ratios,
      NO_VALUATION,
      derivation.periodType,
      undefined,
    );
  }

  it("WRITES roe, roa and roce when the annual is available", () => {
    // THE ASSERTION THIS TICKET EXISTS FOR.
    // MUT: in `chooseRatioDerivationInputs`, return `latestFinancials`
    // unconditionally -> all three land in `unfilled` and this goes red.
    const plan = planFor({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: WITH_BALANCE_SHEET,
      latestAnnualPeriodType: "ANNUAL",
    });

    for (const col of ["roe", "roa", "roce"] as const) {
      assert.ok(
        typeof plan.set[col] === "number",
        `${col} must be WRITTEN, but was unfilled: ${JSON.stringify(
          plan.unfilled.find((u) => u.column === col),
        )}`,
      );
    }
    assert.equal(
      plan.set.returnBasis !== undefined,
      true,
      "a derived return must carry its denominator stamp",
    );
  });

  it("still refuses them when there is genuinely no annual", () => {
    // The fallback path must NOT have been widened into writing a quarterly
    // balance-sheet ratio — that would be a different defect in the other
    // direction, and `PERIOD_DEPENDENT_COLUMNS` is what prevents it.
    const plan = planFor({
      latestFinancials: QUARTERLY,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: undefined,
      latestAnnualPeriodType: undefined,
    });

    for (const col of ["roe", "roa", "roce"] as const) {
      assert.equal(
        plan.set[col],
        undefined,
        `${col} must NOT be written from a quarterly`,
      );
      assert.ok(
        plan.unfilled.some((u) => u.column === col),
        `${col} must be reported as unfilled, with a reason`,
      );
    }
  });

  it("refuses a quarterly balance sheet even when the figures ARE present", () => {
    // GLAXO's half-year carries totalAssets, so `deriveRatios` produces all
    // three — and they must STILL be refused when the plan is told QUARTERLY,
    // because the incumbent column is annual. This pins that the fix did not
    // work by accidentally disabling `PERIOD_DEPENDENT_COLUMNS`.
    // MUT: delete the period guard in `planRatiosWrite`'s `put` -> red.
    const plan = planFor({
      latestFinancials: WITH_BALANCE_SHEET,
      latestPeriodType: "QUARTERLY",
      latestAnnualFinancials: undefined,
      latestAnnualPeriodType: undefined,
    });

    assert.equal(plan.set.roce, undefined);
    assert.ok(
      plan.unfilled.some(
        (u) => u.column === "roce" && /refused: QUARTERLY/.test(u.reason),
      ),
      "the refusal must name the period, not a missing input",
    );
  });
});
