/**
 * MONEY-1220 — the eight ratio columns that were parked as "XBRL cannot supply
 * these" and are in fact ordinary arithmetic over data we already hold.
 *
 * Every test here is really one assertion in two forms: **a missing input must
 * produce null, never a number**. The failure mode is not a wrong ratio, it is
 * a CONFIDENT wrong ratio — a 100% gross margin from an unmapped cost line, a
 * positive-looking CAGR across a loss year, a beta from three weeks of trading
 * — landing in a screener column a user then filters on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  currentRatio,
  grossMargin,
  cagr,
  pegRatio,
  beta,
  deriveExtendedRatios,
  EXTENDED_RATIO_COLUMNS,
  BETA_MIN_OBSERVATIONS,
  BETA_EXTREME_LOG_RETURN,
  type AnnualPoint,
  type ClosePoint,
} from "../../src/market-data/ratio-derivations";
import { growthPct } from "@usemoney/core/market-data";

describe("currentRatio", () => {
  it("divides current assets by current liabilities", () => {
    const r = currentRatio({ currentAssets: 250, currentLiabilities: 100 });
    assert.equal(r.value, 2.5);
  });

  it("returns null (not 0) when either side is absent", () => {
    assert.equal(currentRatio({ currentAssets: 250 }).value, undefined);
    assert.equal(currentRatio({ currentAssets: 250 }).reason, "no-input");
    assert.equal(currentRatio({ currentLiabilities: 100 }).value, undefined);
  });

  it("refuses a non-positive denominator instead of returning Infinity", () => {
    // Infinity would sort to the top of every "most liquid" screen.
    const r = currentRatio({ currentAssets: 250, currentLiabilities: 0 });
    assert.equal(r.value, undefined);
    assert.equal(r.reason, "non-positive-denominator");
  });
});

describe("grossMargin", () => {
  const income = {
    revenue: 1000,
    costOfMaterialsConsumed: 400,
    purchasesOfStockInTrade: 150,
    changesInInventories: -50, // inventory GREW: a credit, reduces COGS
  };

  it("sums the three Ind-AS cost lines", () => {
    // COGS = 400 + 150 + (−50) = 500 → margin 50%
    //
    // PERCENT, not a fraction — MONEY-1235. This assertion used to expect 0.5,
    // which is what shipped `grossMargin` into a column group whose other
    // members (`netMargin`, `roe`, `roa`) all come from `pct()` and are already
    // x100. The card renders all four with the same formatter, so 0.5 printed
    // as "0.5%" for a 50% margin.
    const r = grossMargin(income, "ind-as");
    assert.ok(r.value !== undefined);
    assert.ok(Math.abs(r.value - 50) < 1e-9, `got ${r.value}`);
  });

  it("ADDS the signed inventory delta rather than abs()-ing it", () => {
    // abs() would give COGS 600 and a 40% margin. The sign is the whole point:
    // a year of stock-building must not read as a year of higher cost.
    const r = grossMargin(income, "ind-as");
    assert.notEqual(r.value, 0.4, "inventory delta was abs()'d");
  });

  it("returns null for lenders — a bank has no cost of materials", () => {
    for (const family of ["banking", "nbfc"] as const) {
      const r = grossMargin(income, family);
      assert.equal(r.value, undefined);
      assert.equal(r.reason, "lender-has-no-cogs");
    }
  });

  it("returns null when ANY cost line is missing — never treats it as zero", () => {
    // This is the fabrication guard. Dropping purchases and summing the rest
    // understates COGS and reports a margin the filing does not support.
    const r = grossMargin(
      { revenue: 1000, costOfMaterialsConsumed: 400, changesInInventories: 0 },
      "ind-as",
    );
    assert.equal(r.value, undefined, "missing cost line was treated as 0");
    assert.equal(r.reason, "no-input");
  });

  it("refuses non-positive revenue", () => {
    const r = grossMargin({ ...income, revenue: 0 }, "ind-as");
    assert.equal(r.reason, "non-positive-denominator");
  });
});

describe("cagr", () => {
  const years: AnnualPoint[] = [
    { fyEndYear: 2025, revenue: 1610.51, netIncome: 200 },
    { fyEndYear: 2024, revenue: 1464.1, netIncome: 180 },
    { fyEndYear: 2023, revenue: 1331, netIncome: 160 },
    { fyEndYear: 2022, revenue: 1210, netIncome: 140 },
    { fyEndYear: 2021, revenue: 1100, netIncome: 120 },
    { fyEndYear: 2020, revenue: 1000, netIncome: 100 },
  ];

  it("computes a 3Y CAGR over exactly three fiscal years", () => {
    // 1610.51 / 1210 over 3y = 10% a year, expressed as PERCENT (MONEY-1235):
    // these land in `revenueGrowth3Y`, whose schema group is `// Growth (YoY %)`
    // and whose sibling `revenueGrowth` is already x100.
    const r = cagr(years, 3, "revenue");
    assert.ok(r.value !== undefined);
    assert.ok(Math.abs(r.value - 10) < 1e-6, `got ${r.value}`);
  });

  it("computes a 5Y CAGR", () => {
    const r = cagr(years, 5, "revenue");
    assert.ok(Math.abs(r.value! - 10) < 1e-6, `got ${r.value}`);
  });

  it("returns null when history is shorter than the window", () => {
    const r = cagr(years.slice(0, 3), 5, "revenue");
    assert.equal(r.value, undefined);
    assert.equal(r.reason, "insufficient-history");
  });

  it("does not treat a GAP in the series as adjacent years", () => {
    // 2022 is missing. A 3Y CAGR from 2025 needs FY2022 specifically; the row
    // three POSITIONS back is FY2021, four years of growth wearing a 3Y label.
    //
    // The series is deliberately LONGER than the window so the length check
    // (`usable.length < years + 1`) passes and the year-matching is what has to
    // catch it — an earlier version of this test was short enough that indexing
    // fell off the end and the bug survived the mutation.
    const gapped: AnnualPoint[] = [
      { fyEndYear: 2025, revenue: 2000 },
      { fyEndYear: 2024, revenue: 1500 },
      { fyEndYear: 2023, revenue: 1200 },
      { fyEndYear: 2021, revenue: 1000 },
      { fyEndYear: 2020, revenue: 900 },
    ];
    const r = cagr(gapped, 3, "revenue");
    assert.equal(r.value, undefined, "gap treated as an adjacent year");
    assert.equal(r.reason, "insufficient-history");
  });

  it("returns null across a sign change rather than a plausible number", () => {
    const loss: AnnualPoint[] = [
      { fyEndYear: 2025, netIncome: 50 },
      { fyEndYear: 2024, netIncome: 20 },
      { fyEndYear: 2023, netIncome: 10 },
      { fyEndYear: 2022, netIncome: -100 },
    ];
    const r = cagr(loss, 3, "netIncome");
    assert.equal(r.value, undefined, "CAGR computed across a loss year");
    assert.equal(r.reason, "sign-change");
  });
});

describe("pegRatio", () => {
  it("divides P/E by growth expressed as a percentage", () => {
    // pe 30, growth 20 (i.e. 20%) → 1.5.
    //
    // The input is a PERCENT — MONEY-1235. The test used to pass 0.2 and the
    // function multiplied by 100 internally, so both sides agreed with each
    // other and disagreed with the only production caller, which passes
    // `deriveRatios`' `earningsGrowth` (already a percent from `growthPct`).
    // Measured before the fix: `pegRatio(30, 18)` = 0.0167 against a
    // conventional 1.667, on a column two screener strategies filter with
    // `< 1` and `< 1.5` — so every symbol with a PEG passed.
    const r = pegRatio(30, 20);
    assert.ok(Math.abs(r.value! - 1.5) < 1e-9, `got ${r.value}`);
  });

  it("REGRESSION: agrees with the scale its only production caller passes", () => {
    // The cross-seam case. `growthPct(118, 100)` is 18 (percent), and that is
    // literally what `xbrl-ratios.ts` hands this function.
    const r = pegRatio(30, growthPct(118, 100));
    assert.ok(Math.abs(r.value! - 30 / 18) < 1e-9, `got ${r.value}`);
  });

  it("returns null for non-positive growth instead of a negative PEG", () => {
    // A negative PEG is not "cheap"; it sorts to the top of a lowest-PEG screen.
    for (const g of [0, -0.1]) {
      const r = pegRatio(30, g);
      assert.equal(r.value, undefined, `PEG computed for growth ${g}`);
      assert.equal(r.reason, "non-positive-growth");
    }
  });

  it("returns null when P/E is absent or non-positive", () => {
    assert.equal(pegRatio(null, 0.2).value, undefined);
    assert.equal(pegRatio(-10, 0.2).value, undefined);
  });
});

describe("beta", () => {
  /** `n` days where the stock moves exactly `slope`× the index. */
  function series(
    n: number,
    slope: number,
  ): {
    stock: ClosePoint[];
    index: ClosePoint[];
  } {
    const stock: ClosePoint[] = [];
    const index: ClosePoint[] = [];
    let s = 100;
    let i = 100;
    for (let k = 0; k < n; k++) {
      const day = new Date(Date.UTC(2024, 0, 1 + k)).toISOString();
      stock.push({ date: day, close: s });
      index.push({ date: day, close: i });
      // Deterministic alternating move, no RNG (Math.random is banned in this
      // repo's scripts and makes a test unreproducible anyway).
      const r = (k % 7) - 3 > 0 ? 0.01 : -0.008;
      i *= Math.exp(r);
      s *= Math.exp(r * slope);
    }
    return { stock, index };
  }

  it("recovers a known slope", () => {
    const { stock, index } = series(BETA_MIN_OBSERVATIONS + 50, 0.8);
    const r = beta(stock, index);
    assert.ok(r.value !== undefined, `unfilled: ${r.reason}`);
    assert.ok(Math.abs(r.value - 0.8) < 0.01, `got ${r.value}`);
  });

  it("refuses below the observation floor", () => {
    const { stock, index } = series(30, 0.8);
    const r = beta(stock, index);
    assert.equal(r.value, undefined, "beta from 30 days");
    assert.equal(r.reason, "insufficient-observations");
  });

  it("pairs on date — unmatched days are dropped, not zero-filled", () => {
    const { stock, index } = series(BETA_MIN_OBSERVATIONS + 50, 1);
    // Remove every other index day: pairs fall below the floor.
    const sparse = index.filter((_, k) => k % 2 === 0);
    const r = beta(stock, sparse);
    assert.equal(r.reason, "insufficient-observations");
  });

  /**
   * Apply a 1:`factor` split to the stock series from index `at` onward.
   *
   * `DailyPrice.close` is where beta reads from, and per MONEY-1175 bhavcopy
   * stores that column RAW (unadjusted). So this is not a hypothetical: the
   * price really does halve overnight, and `adjClose` — the column that would
   * carry the adjusted series — is populated on **0 of 10,615,160** prod rows
   * (measured 2026-08-21), so there is nothing to switch to.
   */
  function splitAt(
    stock: readonly ClosePoint[],
    at: number,
    factor = 2,
  ): ClosePoint[] {
    return stock.map((p, k) =>
      k >= at ? { date: p.date, close: p.close / factor } : { ...p },
    );
  }

  it("REGRESSION: a raw-close split corrupts the slope, and the drop repairs it", () => {
    const n = BETA_MIN_OBSERVATIONS + 50;
    const { stock, index } = series(n, 0.8);
    const at = Math.floor(n / 2);
    const withSplit = splitAt(stock, at);

    const clean = beta(stock, index);
    const corrupted = beta(withSplit, index);
    assert.ok(clean.value !== undefined && corrupted.value !== undefined);
    assert.ok(
      Math.abs(corrupted.value - clean.value) > 0.05,
      `the split had to actually move the slope for this test to mean ` +
        `anything (clean ${clean.value}, corrupted ${corrupted.value})`,
    );

    // The return is attributed to the LATER day — the ex-date, where the
    // post-split price first prints.
    const repaired = beta(withSplit, index, {
      excludeReturnDates: [withSplit[at]!.date],
    });
    assert.equal(repaired.droppedReturns, 1);
    assert.ok(repaired.value !== undefined);
    assert.ok(
      Math.abs(repaired.value - clean.value) < 1e-9,
      `dropping the ex-date return must recover the clean slope exactly ` +
        `(got ${repaired.value}, clean ${clean.value})`,
    );
  });

  it("REFUSES an exclusion date it cannot render — a silent miss is the defect", () => {
    // Deleting the guard left 32/32 green, which is this repo's own
    // "naming a bug is not protection from it" rule. Both shapes are pinned:
    // an Invalid Date, and a year under 1000 whose getTime() IS finite and
    // which renders the well-formed-looking "999-06-15".
    const { stock, index } = series(BETA_MIN_OBSERVATIONS + 10, 0.8);
    for (const bad of [
      new Date("nope"),
      "not-a-date",
      new Date(Date.UTC(999, 5, 15)),
    ] as Array<Date | string>) {
      assert.throws(
        () => beta(stock, index, { excludeReturnDates: [bad] }),
        /unusable date/,
        `beta silently accepted ${String(bad)} — the exclusion would no-op`,
      );
    }
  });

  it("MONEY-1527: an ex-date stored at IST midnight still drops its return", () => {
    // THE SHAPE THAT ACTUALLY REACHES THIS FUNCTION IN PRODUCTION, and the one
    // the test above does not exercise: it passes a BAR's date, which is UTC
    // midnight by construction, so UTC and IST render it identically and the
    // defect is invisible.
    //
    // `CorporateAction.exDate` is a real instant, and prod stores it in TWO
    // conventions — 48,224 rows at 18:30Z (IST midnight of the NEXT calendar
    // day) and 10,863 at 00:00Z. Under a UTC slice the 18:30Z majority keyed
    // one day EARLY, the exclusion set matched nothing, and a 10:1 split fed
    // a roughly -90% log return straight into a published `stock_ratios.beta`
    // while `droppedReturns` read 0.
    const n = BETA_MIN_OBSERVATIONS + 50;
    const { stock, index } = series(n, 0.8);
    const at = Math.floor(n / 2);
    const withSplit = splitAt(stock, at);
    const clean = beta(stock, index);

    // The ex-date bar is `withSplit[at].date` (UTC midnight). Mongo stores the
    // SAME calendar day as 18:30Z of the day BEFORE.
    const exBar = new Date(withSplit[at]!.date);
    const istMidnight = new Date(exBar.getTime() - 5.5 * 60 * 60 * 1000);
    assert.equal(
      istMidnight.toISOString().slice(11, 16),
      "18:30",
      "the fixture must model the 48,224-row convention",
    );
    assert.notEqual(
      istMidnight.toISOString().slice(0, 10),
      exBar.toISOString().slice(0, 10),
      "and it must fall on the PREVIOUS UTC day, or this case proves nothing",
    );

    const repaired = beta(withSplit, index, {
      excludeReturnDates: [istMidnight],
    });

    // THE SLOPE IS THE ASSERTION WITH TEETH, not the count.
    //
    // `droppedReturns` reads 1 BOTH ways and asserting it proves nothing —
    // measured, the pre-fix code also dropped exactly one return, just the
    // WRONG one: D-1 is a trading session, so the early key landed on a real
    // previous bar and discarded its ordinary return while keeping the
    // split's. Pre-fix slope 0.0632 against a clean 0.8000.
    assert.ok(repaired.value !== undefined && clean.value !== undefined);
    assert.ok(
      Math.abs(repaired.value - clean.value) < 1e-9,
      `the slope must recover exactly (got ${repaired.value}, clean ${clean.value})`,
    );
    assert.equal(repaired.droppedReturns, 1, "exactly one return was dropped");

    // And pin the counter's uselessness as a diagnostic, because it is
    // published as `betaReturnsDropped` and an operator will reach for it.
    const poisoned = beta(withSplit, index, {
      excludeReturnDates: [new Date(exBar.getTime() - 86_400_000)],
    });
    assert.equal(
      poisoned.droppedReturns,
      1,
      "dropping the WRONG day still reports a healthy count — the count is " +
        "not a diagnostic, the slope is",
    );
    assert.ok(
      poisoned.value !== undefined &&
        Math.abs(poisoned.value - clean.value) > 0.05,
      "and the slope is wrecked while that count reads healthy",
    );

    // AND THE OTHER CONVENTION MUST STILL WORK. 10,863 rows are stored at UTC
    // midnight; a fix that only moved the renderer would break those instead.
    const utcMidnight = beta(withSplit, index, {
      excludeReturnDates: [exBar],
    });
    assert.equal(
      utcMidnight.droppedReturns,
      1,
      "the 00:00Z convention must keep matching — IST renders it to the same day",
    );
  });

  it("COUNTS a surviving extreme return rather than winsorizing it", () => {
    // The fallback for thin `corporate_actions` coverage: an unexplained ~50%
    // single-session move is almost certainly an action we have no row for.
    // Clipping it would silently repair the one signal that says so — and
    // would also swallow a genuine limit-move, which is real data.
    const n = BETA_MIN_OBSERVATIONS + 50;
    const { stock, index } = series(n, 0.8);
    const at = Math.floor(n / 2);
    const withSplit = splitAt(stock, at);

    const r = beta(withSplit, index);
    assert.equal(r.droppedReturns, 0, "nothing was excluded");
    assert.equal(
      r.extremeReturns,
      1,
      "the |ln(0.5)| = 0.69 jump exceeds the plausible-move threshold",
    );
    assert.ok(
      r.value !== undefined,
      "the regression still runs — the count is a report, not a filter",
    );
    assert.ok(BETA_EXTREME_LOG_RETURN < Math.log(2));
  });

  it("applies the observation floor AFTER the drops", () => {
    // A dropped day is a move the regression never saw, so it must not count
    // toward the floor that exists to stop a handful of moves dominating it.
    const n = BETA_MIN_OBSERVATIONS + 5;
    const { stock, index } = series(n, 1);
    const r = beta(stock, index, {
      excludeReturnDates: stock.slice(0, 10).map((p) => p.date),
    });
    assert.equal(r.reason, "insufficient-observations");
    assert.ok(r.observations < BETA_MIN_OBSERVATIONS);
    assert.ok(r.droppedReturns > 0);
  });

  it("accepts Date and ISO-string exclusions alike", () => {
    // The caller reads `CorporateAction.exDate` (a Date); tests and fixtures
    // spell days as ISO strings. One key function handles both, so an
    // exclusion set cannot silently match nothing.
    const n = BETA_MIN_OBSERVATIONS + 50;
    const { stock, index } = series(n, 1);
    const at = 10;
    const asDate = beta(stock, index, {
      excludeReturnDates: [new Date(stock[at]!.date)],
    });
    const asString = beta(stock, index, {
      excludeReturnDates: [String(stock[at]!.date)],
    });
    assert.equal(asDate.droppedReturns, 1);
    assert.equal(asString.droppedReturns, 1);
  });

  it("reports counts even on a refusal", () => {
    const { stock, index } = series(30, 0.8);
    const r = beta(stock, index);
    assert.equal(r.reason, "insufficient-observations");
    assert.equal(typeof r.observations, "number");
    assert.equal(typeof r.droppedReturns, "number");
    assert.equal(typeof r.extremeReturns, "number");
  });

  it("reports zero index variance instead of emitting NaN", () => {
    const n = BETA_MIN_OBSERVATIONS + 50;
    const stock: ClosePoint[] = [];
    const index: ClosePoint[] = [];
    for (let k = 0; k < n; k++) {
      const day = new Date(Date.UTC(2024, 0, 1 + k)).toISOString();
      stock.push({ date: day, close: 100 + k });
      index.push({ date: day, close: 100 }); // suspended
    }
    const r = beta(stock, index);
    assert.equal(r.value, undefined);
    assert.equal(r.reason, "zero-variance");
  });
});

describe("deriveExtendedRatios", () => {
  it("puts every column in exactly one of values / unfilled", () => {
    const out = deriveExtendedRatios({ annuals: [], family: "ind-as" });
    for (const col of EXTENDED_RATIO_COLUMNS) {
      const inValues = out.values[col] !== undefined;
      const inUnfilled = out.unfilled[col] !== undefined;
      assert.ok(
        inValues !== inUnfilled,
        `${col} is in ${inValues && inUnfilled ? "both" : "neither"}`,
      );
    }
  });

  it("names a reason for every unfilled column — never a bare null", () => {
    const out = deriveExtendedRatios({ annuals: [], family: "banking" });
    for (const [col, reason] of Object.entries(out.unfilled)) {
      assert.ok(
        typeof reason === "string" && reason.length > 0,
        `${col} unfilled with no reason`,
      );
    }
    assert.equal(out.unfilled.grossMargin, "lender-has-no-cogs");
  });

  it("surfaces the beta diagnostics, including on a refusal", () => {
    // "beta is null" and "beta is null because 490 observations became 2 after
    // drops" are different problems with the same column value.
    const out = deriveExtendedRatios({ annuals: [], family: "ind-as" });
    assert.deepEqual(out.betaDiagnostics, {
      droppedReturns: 0,
      extremeReturns: 0,
      observations: 0,
    });
  });

  it("threads betaExcludeDates through to the regression", () => {
    const stock: ClosePoint[] = [];
    const index: ClosePoint[] = [];
    for (let k = 0; k < 20; k++) {
      const d = new Date(Date.UTC(2024, 0, 1 + k)).toISOString();
      stock.push({ date: d, close: 100 + k });
      index.push({ date: d, close: 200 + k });
    }
    const out = deriveExtendedRatios({
      annuals: [],
      family: "ind-as",
      stockCloses: stock,
      indexCloses: index,
      betaExcludeDates: [stock[5]!.date, stock[9]!.date],
    });
    assert.equal(out.betaDiagnostics?.droppedReturns, 2);
    // Still below the floor, so the column stays unfilled — the point is that
    // the exclusion REACHED the regression, not that a beta came out.
    assert.equal(out.unfilled.beta, "insufficient-observations");
  });

  it("emits no non-finite value into a Float column", () => {
    const out = deriveExtendedRatios({
      annuals: [{ fyEndYear: 2025, revenue: 0, netIncome: 0 }],
      latestBalanceSheet: { currentAssets: 1, currentLiabilities: 0 },
      family: "ind-as",
      pe: 0,
      earningsGrowth: 0,
    });
    for (const v of Object.values(out.values)) {
      assert.ok(Number.isFinite(v), `non-finite value emitted: ${v}`);
    }
  });
});
