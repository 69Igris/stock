/**
 * UNIT TEST — the WRITE side of the XBRL → StockFinancials seam
 * (MONEY-1115, Data Engine P10 F3).
 *
 * The sibling suite (`xbrl-projection.test.ts`) covers the projection, the
 * ratios and the reconciliation gate. This one covers the three decisions that
 * only matter once something actually writes:
 *
 *   1. WHICH ROW a filing belongs in (`periodLabel`, `judgeProjectionEligibility`)
 *   2. WHICH FILING owns that row when two of them claim it (`selectFilingForPeriod`)
 *   3. WHAT AN OVERWRITE PRESERVES (`planFinancialsWrite`)
 *
 * ## Why these are worth a suite of their own
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])` — no `source`. Every failure below therefore has the same shape: the
 * write SUCCEEDS, the row looks entirely normal, and the number in it is wrong
 * by a multiple or the evidence of what it replaced is gone. None of them raise,
 * none of them produce an outlier a chart would show, and after the first write
 * there is no second copy left to compare against.
 *
 * The four that carry the weight:
 *
 *   - `REGRESSION: a refresh does not rewrite the displacement record` — the
 *     audit trail evaporating on the SECOND nightly run, replacing "TICKERTAPE
 *     said X" with "NSE_XBRL said X".
 *   - `REGRESSION: a half-yearly filing is refused` and
 *     `REGRESSION: a cumulative quarter is refused` — six months and nine
 *     months of revenue written into a three-month cell (~2x and ~3x).
 *   - `REGRESSION: selection is a function of the SET, not its order` — a row
 *     oscillating between consolidated and standalone on alternate nights.
 *   - `REGRESSION: an owned field the filing did not disclose is NULLED` — the
 *     mixed-provenance row, stamped NSE_XBRL while holding Tickertape's numbers.
 *
 * Everything here is synchronous and pure. No timers, no I/O beyond two
 * `readFileSync` calls for the drift guard, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  BALANCE_SHEET_FIELDS,
  INCOME_FIELDS,
  XBRL_SOURCE,
  existingDisplacement,
  judgeProjectionEligibility,
  ownedFields,
  periodLabel,
  planFinancialsWrite,
  selectFilingForPeriod,
  type DisplacementRecord,
  type FinancialsWritePlan,
  type IncumbentFinancialsRow,
  type ProjectedFinancials,
  type ProjectionRawData,
} from "../../src/market-data/xbrl-projection";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-08-14T09:30:00.000Z");

const FILING = {
  periodEnd: "2025-09-30T00:00:00.000Z",
  periodType: "QUARTERLY",
  basis: "CONSOLIDATED",
  cumulative: false,
  taxonomyVersion: "2020-03-31",
  coverage: 0.8,
  sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/A.xml",
};

function income(
  values: Partial<Record<string, number>> = {},
): ProjectedFinancials {
  return { statementType: "INCOME", ...values } as ProjectedFinancials;
}

function balanceSheet(
  values: Partial<Record<string, number>> = {},
): ProjectedFinancials {
  return { statementType: "BALANCE_SHEET", ...values } as ProjectedFinancials;
}

/**
 * Simulate the writer applying a plan, so the NEXT plan sees what the database
 * would have seen. Without this the idempotency cases would be asserting
 * against a hand-built row — i.e. against an assumption about the writer rather
 * than against the writer.
 */
function applyPlan(
  plan: FinancialsWritePlan,
  previous: IncumbentFinancialsRow | null,
): IncumbentFinancialsRow {
  if (plan.action === "SKIP") {
    assert.ok(previous, "a SKIP with no previous row is not a valid state");
    return previous;
  }
  const row: IncumbentFinancialsRow = {
    source: plan.source ?? null,
    fetchedAt: NOW,
    rawData: plan.rawData as unknown,
  };
  for (const [k, v] of Object.entries(plan.values ?? {})) {
    (row as unknown as Record<string, number | null>)[k] = v;
  }
  return row;
}

/* -------------------------------------------------------------------------- */
/* periodLabel — the JOIN between XbrlFiling and StockFinancials               */
/* -------------------------------------------------------------------------- */

/**
 * Repo root, by walking up to the WORKSPACE LOCKFILE.
 *
 * The established helper in this directory
 * (`instrument-provider-authority.test.ts`) anchors on `turbo.json`, and that
 * anchor is no longer safe: Turborepo supports per-PACKAGE configs, and
 * `packages/core/turbo.json` now exists. From this suite's own workspace the
 * walk therefore stops at `packages/core`, every `readRepoFile` returns "", and
 * a source-text guard silently checks nothing — the failure mode that file's own
 * header warns about, arriving through a door it did not cover.
 *
 * `yarn.lock` exists ONCE, at the workspace root, by definition of a Yarn
 * workspace. It cannot be shadowed by a package.
 */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

function readRepoFile(...parts: string[]): string {
  const full = join(repoRoot(), ...parts);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

describe("periodLabel addresses the SAME row the evidence gate measured", () => {
  /**
   * This block used to hold a VERBATIM copy of the reconcile script's
   * derivation and assert the two agreed month by month. That was the best
   * available guard while the duplication existed — but it made the copy the
   * ORACLE, so when the shared function was found to be wrong (it emitted a
   * bare "2025" against prod labels of "FY 2025", missing 100% of rows) the
   * test defended the bug: correcting core made the suite red and told the
   * author to put the bug back.
   *
   * The duplication itself is now gone — `xbrl-reconcile.ts` imports
   * `periodLabel` from `@usemoney/core/market-data`. Agreement is therefore
   * structural rather than asserted, and what is left to guard is that nobody
   * reintroduces a private twin. (MONEY-1204)
   */

  it("every month of four years produces a well-formed, joinable label", () => {
    let checked = 0;
    for (let year = 2022; year <= 2025; year++) {
      for (let month = 1; month <= 12; month++) {
        // Month end, which is what a period end always is.
        const end = new Date(Date.UTC(year, month, 0));
        assert.match(
          periodLabel(end, "ANNUAL"),
          /^FY \d{4}$/,
          `bad ANNUAL label at ${end.toISOString()}`,
        );
        assert.match(
          periodLabel(end, "QUARTERLY"),
          /^Q[1-4]-\d{4}$/,
          `bad QUARTERLY label at ${end.toISOString()}`,
        );
        checked += 2;
      }
    }
    // Guards the guard: a loop that ran zero times would also pass.
    assert.equal(checked, 4 * 12 * 2);
  });

  it("puts the Indian fiscal quarters where the fiscal year says", () => {
    assert.equal(periodLabel(utc("2025-06-30"), "QUARTERLY"), "Q1-2026");
    assert.equal(periodLabel(utc("2025-09-30"), "QUARTERLY"), "Q2-2026");
    assert.equal(periodLabel(utc("2025-12-31"), "QUARTERLY"), "Q3-2026");
    // A March end belongs to the fiscal year ENDING that calendar year.
    assert.equal(periodLabel(utc("2026-03-31"), "QUARTERLY"), "Q4-2026");
    assert.equal(periodLabel(utc("2026-03-31"), "ANNUAL"), "FY 2026");
  });

  it("DRIFT GUARD: the reconcile script imports the label, never redefines it", () => {
    // The report is what proves the switchover is safe, and it proves it about
    // whichever row IT joined to. A second definition means the evidence and
    // the write can address DIFFERENT rows while every period simply looks like
    // new ground — invisible, because nothing errors. One definition, one join.
    const src = readRepoFile("scripts", "data", "xbrl-reconcile.ts");
    assert.ok(src.length > 0, "could not read scripts/data/xbrl-reconcile.ts");

    assert.match(
      src,
      /import\s*\{[^}]*\bperiodLabel\b[^}]*\}\s*from\s*"@usemoney\/core\/market-data"/s,
      "xbrl-reconcile.ts must import periodLabel from @usemoney/core/market-data",
    );
    assert.ok(
      !/function\s+periodLabel\s*\(/.test(src),
      "xbrl-reconcile.ts defines its own periodLabel again — delete it and use " +
        "the core one, or the evidence and the write will address different rows.",
    );
    // The bare-year body is the specific bug that copy carried. Pin its absence
    // so a paste-back is caught even if it is named something else.
    assert.ok(
      !src.includes('if (periodType === "ANNUAL") return String(fyEndYear);'),
      "the bare-year ANNUAL label is back in xbrl-reconcile.ts — prod stores " +
        '"FY 2025", so this joins to nothing.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* judgeProjectionEligibility — the multiples that would look normal           */
/* -------------------------------------------------------------------------- */

describe("judgeProjectionEligibility", () => {
  it("accepts an ordinary discrete quarter and names its row", () => {
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-07-01"),
      periodEnd: utc("2025-09-30"),
      periodType: "QUARTERLY",
      cumulative: false,
    });
    assert.ok(v.eligible);
    assert.deepEqual(v.target, { periodType: "QUARTERLY", period: "Q2-2026" });
  });

  it("accepts a full year", () => {
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2026-03-31"),
      periodType: "ANNUAL",
      cumulative: false,
    });
    assert.ok(v.eligible);
    assert.deepEqual(v.target, { periodType: "ANNUAL", period: "FY 2026" });
  });

  it("REGRESSION: a half-yearly filing is refused, not folded into a quarter", () => {
    // StockFinancials.periodType is ANNUAL|QUARTERLY. `xbrl-reconcile.ts` maps
    // everything non-annual to QUARTERLY, which is harmless in a read-only
    // report and is a silent ~2x in a writer: six months of revenue in a
    // three-month cell, under a label that reads perfectly.
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2025-09-30"),
      periodType: "HALF_YEARLY",
      cumulative: false,
    });
    assert.equal(v.eligible, false);
    assert.equal(
      v.eligible === false && v.refusal,
      "HALF_YEARLY_HAS_NO_BUCKET",
    );
  });

  it("REGRESSION: a cumulative YTD column is refused for a quarter", () => {
    // The nine-month roll-up shares its periodEnd with Q3 — which is exactly
    // why `cumulative` is in XbrlFiling's unique key. Its revenue is ~3x the
    // quarter's, and the row it would land in is the quarter's row.
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2025-12-31"),
      periodType: "QUARTERLY",
      cumulative: true,
    });
    assert.equal(v.eligible, false);
    assert.equal(
      v.eligible === false && v.refusal,
      "CUMULATIVE_IS_NOT_A_QUARTER",
    );
  });

  it("allows a cumulative ANNUAL — the twelve-month roll-up IS the year", () => {
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2026-03-31"),
      periodType: "ANNUAL",
      cumulative: true,
    });
    assert.ok(v.eligible);
  });

  it("REGRESSION: a year-long period declared QUARTERLY is refused", () => {
    // `periodType` can come from the INDEX (a catalogue) while the numbers come
    // from the DOCUMENT. When they describe different columns the write is a
    // clean 4x. The span is stored, so the contradiction is checkable.
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2026-03-31"),
      periodType: "QUARTERLY",
      cumulative: false,
    });
    assert.equal(v.eligible, false);
    assert.equal(
      v.eligible === false && v.refusal,
      "PERIOD_SPAN_CONTRADICTS_TYPE",
    );
  });

  it("REGRESSION: a quarter-long period declared ANNUAL is refused", () => {
    const v = judgeProjectionEligibility({
      periodStart: utc("2025-07-01"),
      periodEnd: utc("2025-09-30"),
      periodType: "ANNUAL",
      cumulative: false,
    });
    assert.equal(v.eligible, false);
    assert.equal(
      v.eligible === false && v.refusal,
      "PERIOD_SPAN_CONTRADICTS_TYPE",
    );
  });

  it("refuses an unusable or inverted period rather than computing a span from it", () => {
    for (const meta of [
      { periodStart: utc("2025-09-30"), periodEnd: utc("2025-07-01") },
      { periodStart: utc("2025-07-01"), periodEnd: utc("2025-07-01") },
      {
        periodStart: new Date(Number.NaN),
        periodEnd: utc("2025-09-30"),
      },
    ]) {
      const v = judgeProjectionEligibility({
        ...meta,
        periodType: "QUARTERLY",
        cumulative: false,
      });
      assert.equal(v.eligible, false);
      assert.equal(v.eligible === false && v.refusal, "NO_USABLE_PERIOD");
    }
  });

  it("accepts a 53-week filer and a 61-day stub — the windows are not knife-edge", () => {
    const longYear = judgeProjectionEligibility({
      periodStart: utc("2025-01-01"),
      periodEnd: utc("2025-12-31"),
      periodType: "ANNUAL",
      cumulative: false,
    });
    assert.ok(longYear.eligible);
    const stub = judgeProjectionEligibility({
      periodStart: utc("2025-08-01"),
      periodEnd: utc("2025-09-30"),
      periodType: "QUARTERLY",
      cumulative: false,
    });
    assert.ok(stub.eligible);
  });
});

/* -------------------------------------------------------------------------- */
/* selectFilingForPeriod — two filings, one row                                */
/* -------------------------------------------------------------------------- */

describe("selectFilingForPeriod", () => {
  const cons = {
    basis: "CONSOLIDATED",
    coverage: 0.5,
    filedAt: utc("2025-10-20"),
    sourceUrl: "c.xml",
  };
  const stand = {
    basis: "STANDALONE",
    coverage: 0.95,
    filedAt: utc("2025-10-25"),
    sourceUrl: "s.xml",
  };

  it("REGRESSION: consolidated wins even with worse coverage and an older date", () => {
    // For a holding company the two differ by a MULTIPLE. Coverage is a
    // tie-break, never a reason to report the parent-only numbers as the
    // company's.
    assert.equal(selectFilingForPeriod([cons, stand]), cons);
    assert.equal(selectFilingForPeriod([stand, cons]), cons);
  });

  it("REGRESSION: selection is a function of the SET, not of its order", () => {
    // Without a TOTAL order the winner depends on whatever order the query
    // returned, so the row can flip between two different truths on alternate
    // nights and no single run ever looks wrong.
    const a = {
      basis: "STANDALONE",
      coverage: 0.7,
      filedAt: utc("2025-10-20"),
      sourceUrl: "a.xml",
    };
    const b = {
      basis: "STANDALONE",
      coverage: 0.7,
      filedAt: utc("2025-10-20"),
      sourceUrl: "b.xml",
    };
    const c = {
      basis: "STANDALONE",
      coverage: 0.7,
      filedAt: utc("2025-10-20"),
      sourceUrl: "c.xml",
    };
    const permutations = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    const winners = permutations.map((p) => selectFilingForPeriod(p));
    assert.deepEqual(new Set(winners), new Set([a]));
  });

  it("breaks a same-basis tie on coverage, then on the filing date", () => {
    const low = {
      basis: "STANDALONE",
      coverage: 0.4,
      filedAt: utc("2025-10-25"),
      sourceUrl: "l.xml",
    };
    const high = {
      basis: "STANDALONE",
      coverage: 0.9,
      filedAt: utc("2025-10-20"),
      sourceUrl: "h.xml",
    };
    assert.equal(selectFilingForPeriod([low, high]), high);

    const older = {
      basis: "STANDALONE",
      coverage: 0.9,
      filedAt: utc("2025-10-20"),
      sourceUrl: "o.xml",
    };
    const newer = {
      basis: "STANDALONE",
      coverage: 0.9,
      filedAt: utc("2025-10-25"),
      sourceUrl: "n.xml",
    };
    assert.equal(selectFilingForPeriod([older, newer]), newer);
  });

  it("ranks an unrecognised basis LAST rather than dropping it", () => {
    const unknown = {
      basis: "",
      coverage: 1,
      filedAt: utc("2025-11-01"),
      sourceUrl: "u.xml",
    };
    assert.equal(selectFilingForPeriod([unknown, stand]), stand);
    // On its own it is still usable — a new basis spelling must not silently
    // delete a company's only filing for the period.
    assert.equal(selectFilingForPeriod([unknown]), unknown);
  });

  it("returns null for an empty set instead of undefined", () => {
    assert.equal(selectFilingForPeriod([]), null);
  });

  it("survives a missing filedAt/coverage without ordering on NaN", () => {
    const noMeta = {
      basis: "STANDALONE",
      coverage: null,
      filedAt: null,
      sourceUrl: null,
    };
    const withMeta = {
      basis: "STANDALONE",
      coverage: 0.1,
      filedAt: null,
      sourceUrl: "w.xml",
    };
    assert.equal(selectFilingForPeriod([noMeta, withMeta]), withMeta);
    assert.equal(selectFilingForPeriod([withMeta, noMeta]), withMeta);
  });
});

/* -------------------------------------------------------------------------- */
/* planFinancialsWrite — what an overwrite preserves                           */
/* -------------------------------------------------------------------------- */

describe("planFinancialsWrite — the empty cell", () => {
  it("CREATEs when there is no incumbent, and displaces nothing", () => {
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100, netIncome: 10 }),
      incumbent: null,
      filing: FILING,
      now: NOW,
    });
    assert.equal(plan.action, "CREATE");
    assert.equal(plan.source, XBRL_SOURCE);
    assert.equal(plan.displaced, null);
    assert.equal(plan.rawData?.displacedByXbrl, undefined);
  });
});

describe("planFinancialsWrite — the authority order", () => {
  it("REGRESSION: a lower-ranked challenger cannot overwrite a higher-ranked row", () => {
    // The declared order is the whole point of the module. If a writer can
    // ignore it, MONEY-1175 is back: two sources, no winner, last write wins.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 999 }),
      incumbent: { source: XBRL_SOURCE, revenue: 100 },
      filing: FILING,
      now: NOW,
      challenger: "TICKERTAPE",
    });
    assert.equal(plan.action, "SKIP");
    assert.equal(plan.skipReason, "AUTHORITY");
    assert.equal(plan.values, undefined, "a SKIP must carry no patch");
  });

  it("an unknown incumbent source ranks last and is displaced", () => {
    // `rankOf` puts an unrecognised source at the end deliberately, so a new
    // upstream can fill a gap but never displace something known.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: { source: "SOME_NEW_VENDOR", revenue: 90 },
      filing: FILING,
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.displaced?.displacedSource, "SOME_NEW_VENDOR");
  });
});

describe("planFinancialsWrite — recording what was displaced", () => {
  const tickertape: IncumbentFinancialsRow = {
    source: "TICKERTAPE",
    fetchedAt: new Date("2026-01-05T00:00:00.000Z"),
    rawData: { period: "Q2-2026", revenuef: 95, netPftf: 9 },
    revenue: 95,
    netIncome: 9,
    // Tickertape's annual writer never fills these; the record must still say
    // so explicitly rather than omitting them.
    operatingIncome: null,
    ebitda: null,
    // A REAL vendor value, not null — MONEY-1235. `grossProfit` is no longer an
    // owned field, so this number must survive the update AND must not appear
    // in the displacement record, which exists to preserve what was DESTROYED.
    grossProfit: 41,
  };

  const plan = planFinancialsWrite({
    projected: income({
      revenueFromOperations: 100,
      netIncome: 10,
      operatingIncomeExOtherIncome: 12,
    }),
    incumbent: tickertape,
    filing: FILING,
    unfilled: ["ebitdaBeforeExceptionalItems"],
    now: NOW,
  });

  it("UPDATEs and records the displaced source", () => {
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.displaced?.displacedSource, "TICKERTAPE");
    assert.equal(plan.displaced?.by, XBRL_SOURCE);
    assert.equal(plan.displaced?.displacedAt, NOW.toISOString());
  });

  it("REGRESSION: the record holds the INCUMBENT's numbers, not ours", () => {
    // An inversion here is invisible — the record is well-formed, the row is
    // well-formed, and a restore quietly writes back the values that replaced
    // the originals.
    //
    // `grossProfit` is absent from this record BY CONSTRUCTION and that is the
    // point: the record preserves what the write DESTROYS, and an unowned
    // column is never written, so there is nothing to preserve. Recording it
    // anyway would claim a displacement that did not happen.
    //
    // `otherIncome` IS present and null — MONEY-1250. It is an OWNED column, so
    // the write mentions it and the record must preserve what that write
    // destroys; the incumbent predates the column, so what it destroys is a
    // null. That is the opposite case from `grossProfit` above and the contrast
    // is the rule: owned-and-empty is recorded, unowned is not.
    //
    // MONEY-1255 moved `revenue`, `operatingIncome` and `ebitda` into exactly
    // the `grossProfit` bucket, so the record no longer mentions them and the
    // keys it DOES carry are our own three columns — null here, because this
    // Tickertape row predates all of them. `netIncome` is the only value left
    // in the record, and that is not a weakening: it is the only column of the
    // five that this write actually destroys, which is precisely what the
    // record is for. The `revenue: 95` that used to sit here was preserving a
    // value nothing was going to overwrite.
    assert.deepEqual(plan.displaced?.values, {
      revenueFromOperations: null,
      otherIncome: null,
      operatingIncomeExOtherIncome: null,
      netIncome: 9,
      ebitdaBeforeExceptionalItems: null,
    });
    // The half that replaces it: the vendor's number survives IN ITS COLUMN,
    // which is a stronger guarantee than being copied into a JSON blob.
    assert.ok(!("revenue" in (plan.values ?? {})));
    assert.equal(tickertape.revenue, 95);
  });

  it("keeps the displaced row's own rawData and fetchedAt", () => {
    assert.deepEqual(plan.displaced?.rawData, {
      period: "Q2-2026",
      revenuef: 95,
      netPftf: 9,
    });
    assert.equal(plan.displaced?.fetchedAt, "2026-01-05T00:00:00.000Z");
  });

  it("stores the record IN the row that displaced it", () => {
    assert.deepEqual(plan.rawData?.displacedByXbrl, plan.displaced);
    // …alongside our own provenance, so the row explains itself without a join.
    assert.equal(plan.rawData?.xbrl.filing.sourceUrl, FILING.sourceUrl);
    // A BARE field name still stores `{ field }` with no `needed` —
    // MONEY-1238's back-compat arm, for a caller (the F3 reconcile) that holds
    // only names. Absent `needed` means "not recorded", never "nothing was
    // needed", which is why it is OMITTED rather than written as `[]`.
    assert.deepEqual(plan.rawData?.xbrl.unfilled, [
      { field: "ebitdaBeforeExceptionalItems" },
    ]);
    assert.ok(!("needed" in (plan.rawData?.xbrl.unfilled[0] ?? {})));
  });

  it("REGRESSION: an owned field the filing did not disclose is NULLED", () => {
    // Leaving OUR ebitda column populated from an older filing under a row
    // stamped NSE_XBRL makes the row unattributable — the exact state
    // MONEY-1175 sat in. Nulling is only safe BECAUSE the displaced value is
    // preserved above; both halves are required.
    //
    // The vendor's `ebitda` is NOT what gets nulled any more (MONEY-1255) —
    // that column is unowned, so it is left exactly as it was, asserted
    // alongside. Reading the null off `plan.values?.ebitda` would now pass on
    // an `undefined` (assert.equal is `==`) and prove nothing at all.
    assert.equal(plan.values?.ebitdaBeforeExceptionalItems, null);
    assert.equal(plan.values?.revenueFromOperations, 100);
    assert.ok(
      !("ebitda" in (plan.values ?? {})),
      "the vendor's ebitda column is unowned and must not be nulled",
    );
  });

  it("REGRESSION: `grossProfit` is UNOWNED, so the vendor's value survives", () => {
    // MONEY-1235. XBRL has no COGS concept in any taxonomy NSE files against,
    // so `projectFinancials` can never emit gross profit — for any filer, ever.
    // While the field was OWNED, that meant writing NULL into it on every row
    // this job touched, and the Financials tab would have shown "—" for Gross
    // profit on every XBRL-updated column beside older columns that still had a
    // number. The upgrade would have read as a regression in the most visible
    // place in the product.
    //
    // Unowned means the patch never mentions the column, so a partial update
    // leaves it exactly as it was. The two halves of that claim are asserted
    // separately: absent from the patch, and absent from the field list.
    assert.ok(
      !("grossProfit" in (plan.values ?? {})),
      "an unowned column must not appear in the patch at all — a null would " +
        "erase the vendor's value just as effectively as a wrong number",
    );
    assert.ok(
      !(INCOME_FIELDS as readonly string[]).includes("grossProfit"),
      "grossProfit must not be an owned INCOME field",
    );
    // …and the incumbent that carried 41 is untouched by anything above.
    assert.equal(tickertape.grossProfit, 41);
  });

  it("has no opinion about the cash-flow columns", () => {
    // This module projects no cash-flow statement. A patch that mentioned those
    // columns would be nulling data it never looked at.
    for (const k of [
      "operatingCashFlow",
      "capitalExpenditure",
      "freeCashFlow",
    ]) {
      assert.ok(
        !(k in (plan.values ?? {})),
        `${k} must not appear in the patch`,
      );
    }
  });

  it("patches exactly the owned columns of the statement it is writing", () => {
    assert.deepEqual(
      Object.keys(plan.values ?? {}).sort(),
      [...INCOME_FIELDS].sort(),
    );
    const bs = planFinancialsWrite({
      projected: balanceSheet({ totalAssets: 1, totalEquity: 2 }),
      incumbent: null,
      filing: FILING,
      now: NOW,
    });
    assert.deepEqual(
      Object.keys(bs.values ?? {}).sort(),
      [...BALANCE_SHEET_FIELDS].sort(),
    );
    assert.deepEqual(ownedFields("INCOME"), INCOME_FIELDS);
    assert.deepEqual(ownedFields("BALANCE_SHEET"), BALANCE_SHEET_FIELDS);
  });
});

describe("planFinancialsWrite — idempotency and the audit trail", () => {
  const tickertape: IncumbentFinancialsRow = {
    source: "TICKERTAPE",
    fetchedAt: new Date("2026-01-05T00:00:00.000Z"),
    rawData: { period: "Q2-2026", revenuef: 95 },
    revenue: 95,
    netIncome: 9,
  };
  const projected = income({ revenueFromOperations: 100, netIncome: 10 });

  const first = planFinancialsWrite({
    projected,
    incumbent: tickertape,
    filing: FILING,
    now: NOW,
  });
  const afterFirst = applyPlan(first, tickertape);

  it("the second identical run is a SKIP — the job is a fixpoint", () => {
    const second = planFinancialsWrite({
      projected,
      incumbent: afterFirst,
      filing: FILING,
      now: new Date("2026-08-15T09:30:00.000Z"),
    });
    assert.equal(second.action, "SKIP");
    assert.equal(second.skipReason, "UNCHANGED");
  });

  it("REGRESSION: a refresh does not rewrite the displacement record", () => {
    // THE case this whole design turns on. Every nightly run after the first is
    // a refresh (`chooseAuthority` returns the incumbent as `displaced` on an
    // EQUAL-rank re-write too). If a refresh built a new record, run 2 would
    // overwrite "TICKERTAPE said 95" with "NSE_XBRL said 100", nest the
    // previous rawData inside itself, and leave the row's history a tautology —
    // with no error, no failed write, and no second copy anywhere.
    //
    // A corrected filing is used so the run genuinely WRITES rather than
    // skipping, which is the only way the branch is exercised.
    const corrected = { ...FILING, sourceUrl: "https://…/A-revised.xml" };
    const second = planFinancialsWrite({
      projected: income({ revenueFromOperations: 101, netIncome: 10 }),
      incumbent: afterFirst,
      filing: corrected,
      now: new Date("2026-08-15T09:30:00.000Z"),
    });

    assert.equal(second.action, "UPDATE");
    assert.equal(
      second.displaced,
      null,
      "a source replacing ITSELF has displaced nothing",
    );

    const record = second.rawData?.displacedByXbrl;
    assert.ok(
      record,
      "the original displacement record must survive a refresh",
    );
    assert.equal(record.displacedSource, "TICKERTAPE");
    assert.equal(record.by, XBRL_SOURCE);
    assert.equal(
      record.displacedAt,
      NOW.toISOString(),
      "the ORIGINAL timestamp",
    );
    // `netIncome`, not `revenue` — MONEY-1255. The record only ever holds
    // OWNED columns, and the vendor's `revenue` stopped being one, so it is
    // `netIncome` that carries the original value here now. Reading a key the
    // record cannot contain would compare `undefined` against `undefined` the
    // moment the assertion's expected value was also dropped.
    assert.deepEqual(
      record.values.netIncome,
      9,
      "the ORIGINAL Tickertape value",
    );
    // And the record must not have swallowed the row it now lives in.
    assert.deepEqual(record.rawData, { period: "Q2-2026", revenuef: 95 });
  });

  it("REGRESSION: refreshing a row WE created records no displacement at all", () => {
    // The case the `prior ?? displaced` guard does NOT cover, and the reason
    // `isRefresh` has to exist independently of it. A row this job CREATED has
    // no stored record, so on the next run `prior` is null — and if a refresh
    // built a record anyway, the row would acquire a meaningless
    // "NSE_XBRL displaced NSE_XBRL" entry whose `rawData` is the row's OWN
    // previous projection blob. That is both a lie (nothing was displaced) and
    // the start of unbounded nesting, on rows where nothing ever went wrong.
    const created = planFinancialsWrite({
      projected,
      incumbent: null,
      filing: FILING,
      now: NOW,
    });
    assert.equal(created.action, "CREATE");
    const row = applyPlan(created, null);

    const refreshed = planFinancialsWrite({
      projected: income({ revenueFromOperations: 105, netIncome: 11 }),
      incumbent: row,
      filing: { ...FILING, sourceUrl: "https://…/A-revised.xml" },
      now: new Date("2026-08-15T09:30:00.000Z"),
    });
    assert.equal(refreshed.action, "UPDATE");
    assert.equal(refreshed.displaced, null);
    assert.equal(
      refreshed.rawData?.displacedByXbrl,
      undefined,
      "a row that displaced nothing must carry no displacement record",
    );
  });

  it("REGRESSION: repeated refreshes never nest one record inside another", () => {
    // Nesting is unbounded growth as well as data loss: each run would wrap the
    // previous rawData — record included — one level deeper, until the document
    // is mostly its own history.
    let row: IncumbentFinancialsRow = tickertape;
    let plan = planFinancialsWrite({
      projected,
      incumbent: row,
      filing: FILING,
      now: NOW,
    });
    row = applyPlan(plan, row);

    for (let run = 2; run <= 5; run++) {
      plan = planFinancialsWrite({
        projected: income({ revenueFromOperations: 100 + run, netIncome: 10 }),
        incumbent: row,
        filing: { ...FILING, sourceUrl: `https://…/rev-${run}.xml` },
        now: new Date(`2026-08-${14 + run}T09:30:00.000Z`),
      });
      assert.equal(plan.action, "UPDATE");
      row = applyPlan(plan, row);
    }

    const record = existingDisplacement(row.rawData);
    assert.ok(record, "the record is still there after five runs");
    assert.equal(record.displacedSource, "TICKERTAPE");
    assert.deepEqual(record.values.netIncome, 9);
    // The nesting check: the preserved rawData is Tickertape's flat feed row,
    // not another projection blob.
    assert.equal(
      existingDisplacement(record.rawData),
      null,
      "a record inside the record means the write nested",
    );
    assert.equal(
      (record.rawData as Record<string, unknown>).xbrl,
      undefined,
      "the preserved rawData must be the DISPLACED source's, not ours",
    );
  });

  it("REGRESSION: the FIRST displacement record wins — a later one cannot overwrite it", () => {
    // The second guard, independent of the refresh branch. If a non-XBRL source
    // re-takes the row's `source` stamp (a restore, a seed script, a manual
    // fix), the next projection run is a genuine displacement again — `prior`
    // is set AND `displaced` is non-null. Writing the new record would replace
    // the only copy of the true pre-XBRL state with a copy of whatever the
    // restore put there. The original is the irreplaceable one; the later state
    // is a Tickertape fetch and is reproducible.
    const record: DisplacementRecord = {
      displacedSource: "TICKERTAPE",
      by: XBRL_SOURCE,
      displacedAt: "2026-08-14T09:30:00.000Z",
      // A record as an EARLIER run stored it, carried through verbatim. The
      // keys are deliberately NOT renamed to MONEY-1255's columns: a stored
      // record is opaque data that the planner copies rather than rebuilds, and
      // a record written before the rename must survive one written after it.
      values: { revenue: 95, netIncome: 9 },
      fetchedAt: "2026-01-05T00:00:00.000Z",
      rawData: { period: "Q2-2026", revenuef: 95 },
    };
    const restored: IncumbentFinancialsRow = {
      source: "TICKERTAPE",
      revenue: 97,
      netIncome: 9,
      rawData: {
        xbrl: { filing: FILING, projected, unfilled: [] },
        displacedByXbrl: record,
      },
    };

    const plan = planFinancialsWrite({
      projected,
      incumbent: restored,
      filing: FILING,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.displaced?.displacedSource, "TICKERTAPE");
    assert.deepEqual(
      plan.rawData?.displacedByXbrl,
      record,
      "the stored record must still be the FIRST one, values and timestamp intact",
    );
    assert.equal(plan.rawData?.displacedByXbrl?.values.revenue, 95);
  });

  it("re-writes when the filing changed, even if the numbers did not", () => {
    // A correction NSE publishes at a new URL must move the provenance, or the
    // row keeps pointing at a superseded document forever.
    const second = planFinancialsWrite({
      projected,
      incumbent: afterFirst,
      filing: { ...FILING, sourceUrl: "https://…/A-revised.xml" },
      now: NOW,
    });
    assert.equal(second.action, "UPDATE");
    assert.equal(
      second.rawData?.xbrl.filing.sourceUrl,
      "https://…/A-revised.xml",
    );
  });

  it("re-writes a row of ours that carries no provenance at all", () => {
    // A row stamped NSE_XBRL with no `rawData.xbrl` was written by something
    // older or by hand. Treating it as current would freeze it permanently.
    const second = planFinancialsWrite({
      projected,
      incumbent: {
        source: XBRL_SOURCE,
        revenue: 100,
        netIncome: 10,
        rawData: null,
      },
      filing: FILING,
      now: NOW,
    });
    assert.equal(second.action, "UPDATE");
  });

  it("does NOT skip a TICKERTAPE row whose numbers happen to match ours", () => {
    // Same values, wrong stamp. Skipping would leave the row attributed to a
    // source that no longer owns it, and would never record the displacement.
    const plan = planFinancialsWrite({
      projected,
      incumbent: { source: "TICKERTAPE", revenue: 100, netIncome: 10 },
      filing: FILING,
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.displaced?.displacedSource, "TICKERTAPE");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — a late STANDALONE sibling rewriting the group's numbers        */
/* -------------------------------------------------------------------------- */

describe("planFinancialsWrite — the basis guards", () => {
  /**
   * THE DEFECT, in one sentence: `selectFilingForPeriod` is only correct over
   * the filings ONE RUN CAN SEE, and the writer sees only UNPROJECTED filings.
   *
   * A CONSOLIDATED filing projected and stamped on night 1 is invisible on
   * night 2. Its STANDALONE sibling is a separate `XbrlFiling` row (`basis` is
   * in that table's unique key) with its own `sourceUrl`; NSE routinely
   * publishes it days later, `xbrl-sync` stores it unstamped, and it then forms
   * a group of ONE and wins the selector trivially.
   *
   * Nothing downstream caught it. `chooseAuthority` sees NSE_XBRL vs NSE_XBRL
   * and takes the EQUAL-rank refresh branch (`c <= i`), which exists so a
   * CORRECTED filing can replace its own earlier reading. `sameProvenance`
   * compares `stored.basis === ours.basis`, and CONSOLIDATED ≠ STANDALONE, so
   * the UNCHANGED skip does not fire either. The result was a plain `updated`,
   * with the group's numbers replaced by the parent's — a MULTIPLE for any
   * holding company, on the one table with no `source` in its unique key.
   */
  const STANDALONE = { ...FILING, basis: "STANDALONE" };
  const projected = income({ revenueFromOperations: 100, netIncome: 10 });

  /** A row this job wrote from the CONSOLIDATED filing, as it would look. */
  function ourConsolidatedRow(): IncumbentFinancialsRow {
    const created = planFinancialsWrite({
      projected: income({ revenueFromOperations: 1000, netIncome: 100 }),
      incumbent: null,
      filing: FILING,
      now: NOW,
    });
    assert.equal(created.action, "CREATE");
    return applyPlan(created, null);
  }

  it("REGRESSION: a late STANDALONE sibling cannot rewrite our CONSOLIDATED row", () => {
    // HOLDCO: consolidated Q2 ₹1,000 Cr projected on night 1; standalone Q2
    // ₹400 Cr syncs a day later. Without the guard, night 2 leaves the row
    // reading ₹400 Cr under `source: NSE_XBRL`, counted as a plain `updated`,
    // with nothing anywhere saying which set of accounts it is.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 400, netIncome: 40 }),
      incumbent: ourConsolidatedRow(),
      filing: { ...STANDALONE, sourceUrl: "https://…/A-standalone.xml" },
      now: new Date("2026-08-15T09:30:00.000Z"),
    });
    assert.equal(plan.action, "SKIP");
    assert.equal(plan.skipReason, "BASIS_DOWNGRADE");
    assert.equal(plan.values, undefined, "a SKIP must carry no patch");
    assert.equal(plan.rawData, undefined);
  });

  it("the UPGRADE still writes — consolidated over our own standalone row", () => {
    // The guard must be one-directional. A row derived from a standalone filing
    // is exactly what a later consolidated filing should replace, and freezing
    // it would leave the guard protecting the WRONG number permanently.
    const created = planFinancialsWrite({
      projected: income({ revenueFromOperations: 400, netIncome: 40 }),
      incumbent: null,
      filing: STANDALONE,
      now: NOW,
    });
    const row = applyPlan(created, null);

    const upgraded = planFinancialsWrite({
      projected: income({ revenueFromOperations: 1000, netIncome: 100 }),
      incumbent: row,
      filing: FILING,
      now: new Date("2026-08-15T09:30:00.000Z"),
    });
    assert.equal(upgraded.action, "UPDATE");
    assert.equal(upgraded.values?.revenueFromOperations, 1000);
    assert.equal(
      upgraded.rawData?.xbrl.filing.basis,
      "CONSOLIDATED",
      "the provenance must move with the numbers",
    );
  });

  it("a SAME-basis revision still writes — this is a basis guard, not a freeze", () => {
    // NSE republishes corrected filings at new URLs. Refusing those would make
    // the first filing of a period permanent, which is a different bug of the
    // same size.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 1010, netIncome: 101 }),
      incumbent: ourConsolidatedRow(),
      filing: { ...FILING, sourceUrl: "https://…/A-revised.xml" },
      now: new Date("2026-08-15T09:30:00.000Z"),
    });
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.values?.revenueFromOperations, 1010);
  });

  it("REGRESSION: a STANDALONE winner never displaces a vendor incumbent", () => {
    // The founder decision for MONEY-1235. 3,208 of 10,879 winner periods
    // (29.5%) have standalone-only XBRL while the vendor row is typically
    // consolidated, so writing standalone over it puts us in disagreement with
    // every other site for nearly a third of the universe: 360ONE FY2025
    // totalAssets is 19,768 Cr at the vendor against our standalone 7,332 Cr.
    const vendor: IncumbentFinancialsRow = {
      source: "TICKERTAPE",
      fetchedAt: new Date("2026-01-05T00:00:00.000Z"),
      rawData: { period: "Q2-2026", revenuef: 950 },
      revenue: 950,
      netIncome: 90,
    };
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 400, netIncome: 40 }),
      incumbent: vendor,
      filing: STANDALONE,
      now: NOW,
    });
    assert.equal(plan.action, "SKIP");
    assert.equal(plan.skipReason, "STANDALONE_NO_DISPLACE");
    assert.equal(plan.values, undefined);
    assert.equal(vendor.revenue, 950, "the incumbent is untouched");
  });

  it("but a STANDALONE filing MAY create where no row exists — it beats nothing", () => {
    // The refusal is about DISPLACEMENT, not about standalone being unusable.
    // Extending it to creates would leave 29.5% of periods permanently empty
    // while we hold a perfectly good filing for them.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 400, netIncome: 40 }),
      incumbent: null,
      filing: STANDALONE,
      now: NOW,
    });
    assert.equal(plan.action, "CREATE");
    assert.equal(plan.values?.revenueFromOperations, 400);
    assert.equal(plan.rawData?.xbrl.filing.basis, "STANDALONE");
  });

  it("a CONSOLIDATED winner displaces the vendor exactly as before", () => {
    // The control. If this went to SKIP, the guard would have closed the
    // switchover rather than protecting it.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 1000, netIncome: 100 }),
      incumbent: { source: "TICKERTAPE", revenue: 950, netIncome: 90 },
      filing: FILING,
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.displaced?.displacedSource, "TICKERTAPE");
  });

  it("a row of OURS with no readable provenance stays writable", () => {
    // `storedProvenance` returns null for a row written by hand or by something
    // older. "Unknown" is not evidence of a better basis, and treating it as
    // one would freeze those rows permanently — the case
    // `re-writes a row of ours that carries no provenance at all` guards from
    // the other side.
    const plan = planFinancialsWrite({
      projected,
      incumbent: {
        source: XBRL_SOURCE,
        revenue: 100,
        netIncome: 10,
        rawData: null,
      },
      filing: STANDALONE,
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
  });

  it("an UNRECOGNISED basis is treated as worse than standalone, both ways", () => {
    // `basisRank` puts an unknown vocabulary last, the same choice `rankOf`
    // makes for an unknown source: it may fill a gap, never displace something
    // we understand. A future basis added to the sync and not to the rank must
    // fail SAFE.
    const odd = { ...FILING, basis: "SEGMENT" };
    assert.equal(
      planFinancialsWrite({
        projected,
        incumbent: ourConsolidatedRow(),
        filing: odd,
        now: NOW,
      }).skipReason,
      "BASIS_DOWNGRADE",
    );
    assert.equal(
      planFinancialsWrite({
        projected,
        incumbent: { source: "TICKERTAPE", revenue: 950 },
        filing: odd,
        now: NOW,
      }).skipReason,
      "STANDALONE_NO_DISPLACE",
    );
  });
});

describe("existingDisplacement tolerates every rawData shape in the wild", () => {
  it("returns null for the shapes that are NOT a record", () => {
    for (const raw of [
      null,
      undefined,
      "a string",
      42,
      [],
      {},
      { period: "Q2-2026" },
      { displacedByXbrl: null },
      { displacedByXbrl: "TICKERTAPE" },
      { displacedByXbrl: [] },
      { displacedByXbrl: { by: XBRL_SOURCE } },
    ]) {
      assert.equal(
        existingDisplacement(raw),
        null,
        `expected null for ${JSON.stringify(raw)}`,
      );
    }
  });

  it("returns the record when one is genuinely there", () => {
    const record: DisplacementRecord = {
      displacedSource: "TICKERTAPE",
      by: XBRL_SOURCE,
      displacedAt: NOW.toISOString(),
      values: { revenue: 95 },
      fetchedAt: null,
      rawData: null,
    };
    const raw: ProjectionRawData = {
      xbrl: {
        filing: FILING,
        projected: income({ revenueFromOperations: 100 }),
        unfilled: [],
      },
      displacedByXbrl: record,
    };
    assert.deepEqual(existingDisplacement(raw), record);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — the CREATE branch, the basis COLUMN, and `unfilled.needed`     */
/* -------------------------------------------------------------------------- */

describe("planFinancialsWrite — CREATE sits BELOW the basis guards", () => {
  const standalone = { ...FILING, basis: "STANDALONE" };

  it("a STANDALONE filing with no incumbent still CREATEs", () => {
    // The reorder's whole safety argument: with `incumbent === null`,
    // `chooseAuthority` returns `displaced: null`, `storedProvenance` is null
    // and `isRefresh` is false, so every guard above is PROVABLY inert. If this
    // ever goes red the reorder changed a write decision, which it must not —
    // "standalone beats nothing" (`STANDALONE_NO_DISPLACE`'s own doc).
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: null,
      filing: standalone,
      now: NOW,
    });
    assert.equal(plan.action, "CREATE");
    assert.equal(plan.skipReason, undefined);
    assert.equal(plan.source, XBRL_SOURCE);
    assert.equal(plan.displaced, null);
  });

  it("an UNRECOGNISED basis with no incumbent still CREATEs", () => {
    // `basisRank` puts an unknown basis BELOW standalone, so this is the
    // strictest input the guards can be handed. It must still create.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: null,
      filing: { ...FILING, basis: "IFRS-SEGMENT" },
      now: NOW,
    });
    assert.equal(plan.action, "CREATE");
  });
});

describe("planFinancialsWrite — the `basis` COLUMN is read (MONEY-1238)", () => {
  // A row of OURS whose `rawData` carries no XBRL provenance at all. Before
  // this the guard read "unknown basis" and left it writable, so a STANDALONE
  // sibling could silently rewrite a CONSOLIDATED-derived row.
  const ourRowNoProvenance: IncumbentFinancialsRow = {
    source: XBRL_SOURCE,
    rawData: { some: "blob from an older writer" },
    revenue: 900,
  };

  it("refuses a STANDALONE refresh over a CONSOLIDATED-columned row", () => {
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: { ...ourRowNoProvenance, basis: "CONSOLIDATED" },
      filing: { ...FILING, basis: "STANDALONE" },
      now: NOW,
    });
    assert.equal(plan.action, "SKIP");
    assert.equal(plan.skipReason, "BASIS_DOWNGRADE");
    assert.match(plan.reason, /CONSOLIDATED/);
  });

  it("is INERT when the column is absent — the pre-existing-row population", () => {
    // `db push` creates indexes, not fields, so ~32,359 rows have no `basis`
    // attribute at all. A fallback that refused on absence would freeze exactly
    // the population it was added after.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: ourRowNoProvenance,
      filing: { ...FILING, basis: "STANDALONE" },
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
  });

  it("does not refuse an EQUAL or BETTER basis", () => {
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: { ...ourRowNoProvenance, basis: "STANDALONE" },
      filing: { ...FILING, basis: "CONSOLIDATED" },
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
  });

  it("rawData provenance still WINS over the column", () => {
    // The column is a fallback, never the authority: it is written by the same
    // upsert as the numbers but is not in the unique key, while `rawData`
    // provenance is atomic with the values it describes.
    //
    // The fixture has to make the two DISAGREE in a way the guard can act on,
    // or the assertion is vacuous. Provenance says STANDALONE and we are
    // STANDALONE — an equal basis, which is a genuine revision and writes. The
    // column says CONSOLIDATED, which would make the same write a downgrade and
    // SKIP. So the verdict is decided entirely by which of the two is read
    // first, which is the property under test.
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: {
        source: XBRL_SOURCE,
        basis: "CONSOLIDATED",
        rawData: {
          xbrl: {
            filing: { ...FILING, basis: "STANDALONE" },
            projected: income({ revenueFromOperations: 900 }),
            unfilled: [],
          },
        },
        revenue: 900,
      },
      filing: { ...FILING, basis: "STANDALONE" },
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
    assert.equal(plan.skipReason, undefined);
  });
});

describe("planFinancialsWrite — `unfilled` keeps the CONCEPT (MONEY-1238)", () => {
  it("stores field AND the concepts it needed", () => {
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: null,
      filing: FILING,
      unfilled: [
        {
          field: "ebitdaBeforeExceptionalItems",
          needed: ["depreciationAndAmortisation"],
        },
        { field: "netIncome", needed: ["profitForPeriod", "profitAfterTax"] },
      ],
      now: NOW,
    });
    assert.deepEqual(plan.rawData?.xbrl.unfilled, [
      {
        field: "ebitdaBeforeExceptionalItems",
        needed: ["depreciationAndAmortisation"],
      },
      { field: "netIncome", needed: ["profitForPeriod", "profitAfterTax"] },
    ]);
  });

  it("COPIES the concept array — the stored blob cannot alias the caller's", () => {
    const needed = ["depreciationAndAmortisation"];
    const plan = planFinancialsWrite({
      projected: income({ revenueFromOperations: 100 }),
      incumbent: null,
      filing: FILING,
      unfilled: [{ field: "ebitdaBeforeExceptionalItems", needed }],
      now: NOW,
    });
    needed.push("mutated-after-the-fact");
    assert.deepEqual(plan.rawData?.xbrl.unfilled[0]?.needed, [
      "depreciationAndAmortisation",
    ]);
  });
});
