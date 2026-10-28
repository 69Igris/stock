/**
 * The shared Tickertape → `StockFinancials` mapper — MONEY-1205.
 *
 * ## Why this is a CAPTURED-FIXTURE test and not a hand-written one
 *
 * The bug being closed here is entirely a bug about what the API actually
 * emits. Five writers each carried their own key map; three read a `period` key
 * that does not exist, and the two that read `displayPeriod` correctly then read
 * `incNpat` / `bsTass` / `cfOcf`, which do not exist either. Every one of those
 * maps would pass a test written from the same assumption that produced them.
 *
 * So the inputs below are the REAL response bodies, fetched read-only from
 * `api.tickertape.in` and checked in verbatim under `__tests__/fixtures/`. A
 * test that invents its own input can only prove the mapper self-consistent.
 * That is precisely how the previous quarterly test stayed green while prod
 * accumulated **zero** QUARTERLY rows: it fed the mapper the shape the broken
 * CLIENT emitted rather than the shape the API emits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  mapTickertapeStatementRow,
  tickertapeStatementColumns,
  parseTickertapePeriodEnd,
  TICKERTAPE_STATEMENT_KEYS,
  shouldBumpFinancialsSyncedAt,
  groupFinancials,
} from "../src/data-sources/db-store-logic";

const FIXTURES = join(import.meta.dirname, "fixtures");

function loadFixture(name: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
    success: boolean;
    data: Array<Record<string, unknown>>;
  };
  assert.equal(parsed.success, true, `${name}: fixture is not a success body`);
  assert.ok(Array.isArray(parsed.data) && parsed.data.length > 0, name);
  return parsed.data;
}

const INCOME = loadFixture("tickertape-annual-income-HDBK.json");
const BALANCE = loadFixture("tickertape-annual-balancesheet-HDBK.json");
const CASHFLOW = loadFixture("tickertape-annual-cashflow-HDBK.json");
const INTERIM = loadFixture("tickertape-interim-income-HDBK.json");

/** The FY-2022 row of each annual statement — the fixture's oldest full year. */
const fy = (rows: Array<Record<string, unknown>>, label = "FY 2022") => {
  const row = rows.find((r) => r.displayPeriod === label);
  assert.ok(row, `fixture has no ${label} row`);
  return row;
};

// ══════════════════════════════════════════════════════════════════════
// The fixture itself — guard the premises the mapper is built on.
// ══════════════════════════════════════════════════════════════════════

describe("captured Tickertape fixtures (the premises)", () => {
  it("has NO `period` key on any row — only `displayPeriod`", () => {
    // THE bug. `if (!row.period) continue` skipped 100% of rows in three
    // separate writers because of this one fact.
    for (const [name, rows] of [
      ["income", INCOME],
      ["balance", BALANCE],
      ["cashflow", CASHFLOW],
      ["interim", INTERIM],
    ] as const) {
      for (const row of rows) {
        assert.equal(
          Object.hasOwn(row, "period"),
          false,
          `${name}: a row unexpectedly has a "period" key`,
        );
        assert.equal(
          typeof row.displayPeriod,
          "string",
          `${name}: a row is missing "displayPeriod"`,
        );
      }
    }
  });

  it("carries none of the five keys the old quarterly mapper read", () => {
    for (const row of INTERIM) {
      for (const dead of ["period", "revenuef", "netPftf", "eps", "operPftf"]) {
        assert.equal(
          Object.hasOwn(row, dead),
          false,
          `interim row unexpectedly has "${dead}"`,
        );
      }
    }
  });

  it("carries none of the six keys the seed script read", () => {
    const dead = ["incNpat", "bsTass", "bsTdbt", "bsTeq", "cfOcf", "cfFcf"];
    for (const rows of [INCOME, BALANCE, CASHFLOW]) {
      for (const row of rows) {
        for (const k of dead) {
          assert.equal(Object.hasOwn(row, k), false, `unexpected key ${k}`);
        }
      }
    }
  });

  it("proves incToi is TAX and incIoi is INTEREST, by identity", () => {
    // The two naming traps. `incPbt − incToi = incNinc` can only hold if
    // `incToi` is tax; `incPbi − incIoi = incPbt` can only hold if `incIoi` is
    // finance cost. Asserted rather than asserted-in-a-comment.
    for (const row of INCOME) {
      const pbt = row.incPbt as number;
      const toi = row.incToi as number;
      const ninc = row.incNinc as number;
      const pbi = row.incPbi as number;
      const ioi = (row.incIoi as number | null) ?? 0;
      assert.ok(Math.abs(pbt - toi - ninc) < 0.02 * Math.abs(ninc));
      assert.ok(Math.abs(pbi - ioi - pbt) < 0.02 * Math.abs(pbt));
    }
  });

  it("proves incEbi − incDep = incPbi, so operatingIncome is incPbi", () => {
    for (const row of INCOME) {
      const ebi = row.incEbi as number;
      const dep = (row.incDep as number | null) ?? 0;
      const pbi = row.incPbi as number;
      assert.ok(Math.abs(ebi - dep - pbi) < 0.02 * Math.abs(pbi));
    }
  });

  it("has incOpc / incGpro null-or-absent on EVERY row — never a number", () => {
    // They look like the obvious sources for operatingIncome and grossProfit
    // and they carry no data anywhere.
    for (const row of INCOME) {
      for (const k of ["incOpc", "incGpro", "incCrev"]) {
        assert.notEqual(
          typeof row[k],
          "number",
          `${String(row.displayPeriod)}: ${k} unexpectedly carries a number`,
        );
      }
    }
  });

  it("gives the TTM row a DIFFERENT key set — absent, not null", () => {
    // Discovered while writing this test, and it matters: on the FY rows
    // `incGpro` is present-and-null (DISCLOSED-ABSENT ⇒ the mapper writes
    // null); on TTM the key is missing entirely (UNRESOLVED ⇒ the mapper omits
    // it). Both are correct, and they are different writes — which is only
    // expressible because the mapper distinguishes the two states.
    const ttm = INCOME.find((r) => r.displayPeriod === "TTM")!;
    const fy2022 = fy(INCOME);
    for (const k of ["incOpc", "incGpro", "incCrev"]) {
      assert.equal(Object.hasOwn(fy2022, k), true, `FY 2022 lost ${k}`);
      assert.equal(Object.hasOwn(ttm, k), false, `TTM unexpectedly has ${k}`);
    }
    assert.equal(
      Object.hasOwn(
        mapTickertapeStatementRow("INCOME", fy2022)!,
        "grossProfit",
      ),
      true,
    );
    assert.equal(
      Object.hasOwn(mapTickertapeStatementRow("INCOME", ttm)!, "grossProfit"),
      false,
    );
  });

  it("ships the TTM row with a BLANK endDate — the non-finite trap", () => {
    // `new Date("")` is an Invalid Date. 2,123 of prod's 32,359 rows are in
    // this state, so this is not an edge case, it is 6.6% of the table.
    const ttm = INCOME.find((r) => r.displayPeriod === "TTM");
    assert.ok(ttm, "income fixture lost its TTM row");
    assert.equal(ttm.endDate, "");
    assert.equal(Number.isFinite(new Date("").getTime()), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The contract: all 13 columns + periodEnd resolve from the real payloads.
// ══════════════════════════════════════════════════════════════════════

describe("mapTickertapeStatementRow — the 13-column contract", () => {
  it("resolves every INCOME column from the real annual payload", () => {
    const row = fy(INCOME);
    const m = mapTickertapeStatementRow("INCOME", row, "ANNUAL");
    assert.ok(m);
    assert.equal(m.period, "FY 2022");
    assert.equal(m.periodEnd?.toISOString(), "2022-03-31T00:00:00.000Z");
    assert.equal(m.revenue, row.incTrev);
    assert.equal(m.ebitda, row.incEbi);
    assert.equal(m.operatingIncome, row.incPbi); // EBIT, NOT incOpc
    assert.equal(m.netIncome, row.incNinc);
    // Present-and-null in the source ⇒ DISCLOSED-ABSENT ⇒ written as null.
    assert.equal(m.grossProfit, null);
    assert.ok(Object.hasOwn(m, "grossProfit"));
  });

  it("resolves every BALANCE_SHEET column from the real payload", () => {
    const row = fy(BALANCE);
    const m = mapTickertapeStatementRow("BALANCE_SHEET", row, "ANNUAL");
    assert.ok(m);
    assert.equal(m.totalAssets, row.balTota);
    assert.equal(m.totalLiabilities, row.balTotl);
    assert.equal(m.totalEquity, row.balTeq);
    assert.equal(m.totalCash, row.balCsti);
    // HDFCBANK is a bank: `balTdeb` is null. It must NOT fall back to
    // `balTltd` (long-term debt only) — a different concept entirely.
    assert.equal(m.totalDebt, null);
    assert.notEqual(row.balTltd, null);
    assert.notEqual(m.totalDebt, row.balTltd);
  });

  it("resolves every CASH_FLOW column from the real payload", () => {
    const row = fy(CASHFLOW);
    const m = mapTickertapeStatementRow("CASH_FLOW", row, "ANNUAL");
    assert.ok(m);
    assert.equal(m.operatingCashFlow, row.cafCfoa);
    assert.equal(m.capitalExpenditure, row.cafCexp);
    assert.equal(m.freeCashFlow, row.cafFcf);
    // capex is stored POSITIVE, per cfoa − capex = fcf.
    assert.ok((m.capitalExpenditure as number) > 0);
    const diff =
      (m.operatingCashFlow as number) -
      (m.capitalExpenditure as number) -
      (m.freeCashFlow as number);
    assert.ok(Math.abs(diff) < 0.01);
  });

  it("resolves the QUARTERLY income columns from the real interim payload", () => {
    const row = INTERIM[0]!;
    const m = mapTickertapeStatementRow("INCOME", row, "QUARTERLY");
    assert.ok(m);
    assert.equal(m.period, row.displayPeriod);
    assert.equal(m.periodEnd?.toISOString(), row.endDate);
    assert.equal(m.revenue, row.qIncTrev);
    assert.equal(m.netIncome, row.qIncNinc);
    assert.equal(m.operatingIncome, row.qIncPbi);
    // qIncEbi → ebitda. The old client dropped EBITDA entirely.
    assert.equal(m.ebitda, row.qIncEbi);
  });

  it("covers all 13 columns across the three annual statements", () => {
    const seen = new Set<string>();
    for (const [stmt, rows] of [
      ["INCOME", INCOME],
      ["BALANCE_SHEET", BALANCE],
      ["CASH_FLOW", CASHFLOW],
    ] as const) {
      const m = mapTickertapeStatementRow(stmt, fy(rows), "ANNUAL");
      assert.ok(m);
      for (const k of Object.keys(tickertapeStatementColumns(m))) {
        if (k !== "periodEnd") seen.add(k);
      }
    }
    assert.deepEqual(
      [...seen].sort(),
      [
        "capitalExpenditure",
        "ebitda",
        "freeCashFlow",
        "grossProfit",
        "netIncome",
        "operatingCashFlow",
        "operatingIncome",
        "revenue",
        "totalAssets",
        "totalCash",
        "totalDebt",
        "totalEquity",
        "totalLiabilities",
      ],
      "the mapper no longer covers all 13 StockFinancials columns",
    );
  });

  it("maps EVERY row of EVERY fixture without dropping one", () => {
    for (const [stmt, rows, pt] of [
      ["INCOME", INCOME, "ANNUAL"],
      ["BALANCE_SHEET", BALANCE, "ANNUAL"],
      ["CASH_FLOW", CASHFLOW, "ANNUAL"],
      ["INCOME", INTERIM, "QUARTERLY"],
    ] as const) {
      for (const row of rows) {
        const m = mapTickertapeStatementRow(stmt, row, pt);
        assert.ok(m, `${stmt}/${pt} dropped ${String(row.displayPeriod)}`);
        assert.ok(m.period.length > 0);
      }
    }
  });

  it("omits periodEnd for the TTM row rather than writing an Invalid Date", () => {
    const ttm = INCOME.find((r) => r.displayPeriod === "TTM")!;
    const m = mapTickertapeStatementRow("INCOME", ttm, "ANNUAL");
    assert.ok(m);
    assert.equal(m.period, "TTM");
    assert.equal(Object.hasOwn(m, "periodEnd"), false);
    // …and the row's real figures still resolve. A blank date must not cost
    // the whole row.
    assert.equal(m.revenue, ttm.incTrev);
  });

  it("returns null for an unkeyable row (period is part of the unique key)", () => {
    assert.equal(mapTickertapeStatementRow("INCOME", {}), null);
    assert.equal(
      mapTickertapeStatementRow("INCOME", { displayPeriod: "   " }),
      null,
    );
  });

  it("accepts `period` as a fallback so stored rawData round-trips", () => {
    const m = mapTickertapeStatementRow("INCOME", {
      period: "FY 2020",
      incTrev: 12,
    });
    assert.equal(m?.period, "FY 2020");
    assert.equal(m?.revenue, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE LANDMINE. The property the whole ticket turns on.
// ══════════════════════════════════════════════════════════════════════

describe("LANDMINE: an unresolvable key must never null an incumbent", () => {
  /**
   * `financial-data-sync.ts` used to write, in an UNCONDITIONAL `update:`
   *
   *     revenue: (row.revenue as number | undefined) ?? null
   *
   * against the raw row. `row.revenue` does not exist, so that expression is
   * `null`. It was inert only because `if (!period) continue` skipped every row
   * first. Repairing the period alone would have ARMED it — nulling `revenue`
   * and `ebitda` on the 12,000+ prod rows that carry them, while `source` went
   * on asserting TICKERTAPE.
   *
   * The guarantee is structural: a column the mapper cannot positively resolve
   * is ABSENT from the returned object. Prisma treats an absent/`undefined`
   * key in `update:` as "leave this column alone", which a spread reproduces
   * exactly — so the spread IS the assertion.
   */
  it("OMITS the key entirely (not null) when the source key is absent", () => {
    // A balance-sheet row that is missing `balTdeb` altogether — not null,
    // ABSENT, which is the state a feed change would produce.
    const row = { ...fy(BALANCE) };
    delete row.balTdeb;
    delete row.balTota;

    const m = mapTickertapeStatementRow("BALANCE_SHEET", row, "ANNUAL");
    assert.ok(m);
    const columns = tickertapeStatementColumns(m);

    assert.equal(Object.hasOwn(columns, "totalDebt"), false);
    assert.equal(Object.hasOwn(columns, "totalAssets"), false);
    assert.equal(columns.totalDebt, undefined);
    // Sibling columns still resolve — omission is per-column, not per-row.
    assert.equal(columns.totalEquity, row.balTeq);
  });

  it("leaves the incumbent value INTACT through the update spread", () => {
    const row = { ...fy(BALANCE) };
    delete row.balTota;
    const m = mapTickertapeStatementRow("BALANCE_SHEET", row, "ANNUAL")!;
    const columns = tickertapeStatementColumns(m);

    // Exactly what the five writers do: `update: { ...columns, fetchedAt }`.
    const incumbent = {
      totalAssets: 2_122_934.3,
      totalEquity: 1,
      source: "NSE_XBRL",
    };
    const afterUpdate = { ...incumbent, ...columns };

    assert.equal(
      afterUpdate.totalAssets,
      2_122_934.3,
      "an unresolvable source key NULLED the incumbent — the MONEY-1205 landmine is back",
    );
    // The resolvable sibling is still updated, so this is not just "writes nothing".
    assert.equal(afterUpdate.totalEquity, row.balTeq);
  });

  it("protects revenue/ebitda specifically — the only real data in prod", () => {
    // A cash-flow row mapped as INCOME resolves NOTHING: no income keys exist
    // on it. Every income column must be absent, so a mis-typed row can never
    // wipe the two populated columns.
    const m = mapTickertapeStatementRow("INCOME", fy(CASHFLOW), "ANNUAL")!;
    const columns = tickertapeStatementColumns(m);
    // No income key exists on a cash-flow row, so NO income column resolves.
    for (const c of [
      "revenue",
      "ebitda",
      "netIncome",
      "operatingIncome",
      "grossProfit",
    ]) {
      assert.equal(Object.hasOwn(columns, c), false, `${c} resolved`);
    }

    const incumbent = { revenue: 470_915.93, ebitda: 100_043.21 };
    const after = { ...incumbent, ...columns };
    assert.equal(after.revenue, 470_915.93);
    assert.equal(after.ebitda, 100_043.21);
    // `periodEnd` IS still resolved and spread — it is a real column on this
    // row, and writers do update it. Only the value columns are protected.
    assert.ok(columns.periodEnd instanceof Date);
  });

  it("still writes an explicit null when the source DISCLOSED the field empty", () => {
    // The other half of the rule: `balTdeb: null` on a bank is the source
    // positively saying "no total debt". That must reach the column, or a
    // stale value would survive forever.
    const m = mapTickertapeStatementRow("BALANCE_SHEET", fy(BALANCE))!;
    const columns = tickertapeStatementColumns(m);
    assert.equal(Object.hasOwn(columns, "totalDebt"), true);
    assert.equal(columns.totalDebt, null);
    assert.equal({ ...{ totalDebt: 999 }, ...columns }.totalDebt, null);
  });

  it("treats blank / dash / non-finite as UNRESOLVED, never as 0", () => {
    // `Number("")` is 0. A feed that starts sending "" or "-" must not zero
    // a company's revenue.
    for (const blank of ["", "  ", "-", "—", "NA", "na"]) {
      const m = mapTickertapeStatementRow("INCOME", {
        displayPeriod: "FY 2024",
        incTrev: blank,
      })!;
      assert.equal(
        Object.hasOwn(m, "revenue"),
        false,
        `"${blank}" resolved instead of being omitted`,
      );
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      const m = mapTickertapeStatementRow("INCOME", {
        displayPeriod: "FY 2024",
        incTrev: bad,
      })!;
      assert.equal(Object.hasOwn(m, "revenue"), false);
    }
  });

  it("keeps a genuine 0 — zero is a real reported figure", () => {
    const m = mapTickertapeStatementRow("INCOME", {
      displayPeriod: "FY 2024",
      incTrev: 0,
    })!;
    assert.equal(m.revenue, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Supporting helpers
// ══════════════════════════════════════════════════════════════════════

describe("parseTickertapePeriodEnd", () => {
  it("parses a real ISO endDate", () => {
    assert.equal(
      parseTickertapePeriodEnd("2022-03-31T00:00:00.000Z")?.toISOString(),
      "2022-03-31T00:00:00.000Z",
    );
  });

  it("returns undefined for blank / garbage / Invalid Date", () => {
    for (const v of ["", "   ", "not-a-date", null, undefined, 42, {}]) {
      assert.equal(parseTickertapePeriodEnd(v), undefined, String(v));
    }
    assert.equal(parseTickertapePeriodEnd(new Date("nope")), undefined);
  });
});

describe("TICKERTAPE_STATEMENT_KEYS", () => {
  it("never maps operatingIncome to incOpc (always-null) ", () => {
    assert.equal(
      TICKERTAPE_STATEMENT_KEYS.ANNUAL.INCOME.operatingIncome,
      "incPbi",
    );
    assert.notEqual(
      TICKERTAPE_STATEMENT_KEYS.ANNUAL.INCOME.operatingIncome,
      "incOpc",
    );
  });

  it("never maps totalDebt to balTltd (long-term debt only)", () => {
    assert.equal(
      TICKERTAPE_STATEMENT_KEYS.ANNUAL.BALANCE_SHEET.totalDebt,
      "balTdeb",
    );
  });

  it("has EMPTY quarterly balance-sheet / cash-flow maps (no such feed)", () => {
    assert.deepEqual(TICKERTAPE_STATEMENT_KEYS.QUARTERLY.BALANCE_SHEET, {});
    assert.deepEqual(TICKERTAPE_STATEMENT_KEYS.QUARTERLY.CASH_FLOW, {});
    const m = mapTickertapeStatementRow(
      "BALANCE_SHEET",
      { displayPeriod: "JUN 2026", balTota: 1 },
      "QUARTERLY",
    )!;
    // Row is keyable but carries no columns — never a crash, never a guess.
    assert.deepEqual(tickertapeStatementColumns(m), {});
  });
});

describe("shouldBumpFinancialsSyncedAt (shared with the seed)", () => {
  it("only bumps when a feed actually persisted", () => {
    assert.equal(shouldBumpFinancialsSyncedAt(false, false), false);
    assert.equal(shouldBumpFinancialsSyncedAt(true, false), true);
    assert.equal(shouldBumpFinancialsSyncedAt(false, true), true);
  });
});

describe("groupFinancials carries the typed columns through", () => {
  it("keeps row fields, so rowToStatement has figures to read", () => {
    // The DB-first cache returned nothing for its whole life because only
    // `period` survived this function and the raw keys are `incTrev`, not
    // `revenue`.
    const grouped = groupFinancials([
      {
        statementType: "INCOME",
        period: "FY 2024",
        revenue: 123,
        ebitda: 45,
        rawData: { incTrev: 123, incEbi: 45, displayPeriod: "FY 2024" },
      },
    ]);
    assert.equal(grouped.income.length, 1);
    assert.equal(grouped.income[0]!.revenue, 123);
    assert.equal(grouped.income[0]!.ebitda, 45);
    assert.equal(grouped.income[0]!.period, "FY 2024");
    // …and the raw keys are still present for existing consumers.
    assert.equal(grouped.income[0]!.incTrev, 123);
  });

  it("lets the ROW's period win over a payload key of the same name", () => {
    const grouped = groupFinancials([
      {
        statementType: "INCOME",
        period: "FY 2024",
        rawData: { period: "WRONG", incTrev: 1 },
      },
    ]);
    assert.equal(grouped.income[0]!.period, "FY 2024");
  });
});

// ══════════════════════════════════════════════════════════════════════
// mapRatioFields — the SAME landmine, on a worse model (MONEY-1205)
//
// `StockRatios` is `@@unique([symbol, exchange])`: ONE row per symbol, no
// period dimension, rewritten nightly at 23:30 IST. A bad write is the
// symbol's ENTIRE ratio set, not one period of one statement.
//
// The field NAMES were never wrong here — `mapRatioFields` consumes
// `fetchTickertapeStockRatios`'s already-normalised output. The defect is that
// an ABSENT field was cast to `number | null` and spread into an
// unconditional `update:`, so it wrote NULL.
// ══════════════════════════════════════════════════════════════════════

import { mapRatioFields } from "../src/data-sources/db-store-logic";

describe("mapRatioFields — omits what it cannot resolve", () => {
  it("maps the fields the live payload actually returns", () => {
    // Measured 2026-08-18: the screener honours only these 7 projections.
    const payload = {
      pe: 22.18,
      pb: 2.9,
      roe: 7.71,
      roce: 11.2,
      beta: 0.9,
      divYield: 0.4,
      mCap: 1_791_572.8,
    };
    const out = mapRatioFields(payload);
    assert.equal(out.pe, 22.18);
    assert.equal(out.roe, 7.71);
    assert.equal(out.dividendYield, 0.4);
    assert.equal(out.marketCap, 1_791_572.8);
  });

  it("OMITS the 18 fields the endpoint silently drops", () => {
    const out = mapRatioFields({ pe: 22.18, roe: 7.71 });
    for (const dropped of [
      "roa",
      "evToEbitda",
      "pegRatio",
      "grossMargin",
      "operatingMargin",
      "netMargin",
      "revenueGrowth",
      "earningsGrowth",
      "revenueGrowth3Y",
      "earningsGrowth3Y",
      "revenueGrowth5Y",
      "earningsGrowth5Y",
      "debtToEquity",
      "currentRatio",
      "interestCoverage",
      "enterpriseValue",
      "targetPrice",
      "recommendation",
    ]) {
      assert.equal(
        Object.hasOwn(out, dropped),
        false,
        `${dropped} resolved — it would NULL the column on update`,
      );
    }
  });

  it("LANDMINE: leaves the incumbent ratio set intact through the update spread", () => {
    const out = mapRatioFields({ pe: 22.18 });
    const incumbent = {
      pe: 19,
      roe: 15.3,
      debtToEquity: 0.4,
      recommendation: "BUY",
    };
    const after = { ...incumbent, ...out };
    assert.equal(after.pe, 22.18, "the resolvable field IS updated");
    assert.equal(after.roe, 15.3, "an absent field NULLED a live ratio");
    assert.equal(after.debtToEquity, 0.4);
    assert.equal(after.recommendation, "BUY");
  });

  it("treats an EXPLICIT undefined as absent (the client writes those)", () => {
    // `fetchTickertapeStockRatios` sets `pe: r.pe as number | undefined`, so the
    // own-key EXISTS with an undefined value. An `Object.hasOwn` presence test
    // would re-arm the clobber.
    const payload: Record<string, unknown> = { pe: undefined, roe: 7.71 };
    assert.equal(Object.hasOwn(payload, "pe"), true);
    const out = mapRatioFields(payload);
    assert.equal(Object.hasOwn(out, "pe"), false);
    assert.equal(out.roe, 7.71);
  });

  it("preserves an explicit null (a loss-making company has no P/E)", () => {
    const out = mapRatioFields({ pe: null });
    assert.equal(Object.hasOwn(out, "pe"), true);
    assert.equal(out.pe, null);
  });

  it("keeps a genuine 0 and rejects non-finite / blank", () => {
    assert.equal(mapRatioFields({ divYield: 0 }).dividendYield, 0);
    assert.equal(
      Object.hasOwn(mapRatioFields({ pe: Number.NaN }), "pe"),
      false,
    );
    assert.equal(Object.hasOwn(mapRatioFields({ pe: "" }), "pe"), false);
    assert.equal(
      Object.hasOwn(mapRatioFields({ recommendation: "  " }), "recommendation"),
      false,
    );
    assert.equal(
      mapRatioFields({ recommendation: " BUY " }).recommendation,
      "BUY",
    );
  });

  it("prefers the client's divYield/mCap spellings, falling back to canonical", () => {
    assert.equal(mapRatioFields({ mCap: 1, marketCap: 2 }).marketCap, 1);
    assert.equal(mapRatioFields({ marketCap: 2 }).marketCap, 2);
    assert.equal(mapRatioFields({ dividendYield: 3 }).dividendYield, 3);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The FETCH must follow the periodType — MONEY-1205.
//
// `getOrFetchFinancials(sym, ex, "QUARTERLY")` fetched
// `fetchTickertapeFinancials`, whose URL hardcodes `/annual/normal`, and then
// upserted the result under the CALLER's periodType. Prod has zero QUARTERLY
// rows, so nothing had ever exposed it — and the MONEY-1205 period fix ARMED
// it, because the guard that had been dropping every row was the missing
// `displayPeriod`.
// ══════════════════════════════════════════════════════════════════════

import { tickertapeStatementsForPeriod } from "../src/data-sources/db-store-logic";
import { readFileSync as readSource } from "node:fs";

describe("tickertapeStatementsForPeriod", () => {
  it("serves all three statements for ANNUAL", () => {
    assert.deepEqual(tickertapeStatementsForPeriod("ANNUAL"), [
      "INCOME",
      "BALANCE_SHEET",
      "CASH_FLOW",
    ]);
  });

  it("serves INCOME ONLY for QUARTERLY — the interim feed is P&L-only", () => {
    // Verified live 2026-08-18: /stocks/financials/income/{sid}/interim/normal
    // is 200; balancesheet and cashflow both answer
    // 400 {"success":false,"errorType":"INVALID_INPUT"}.
    assert.deepEqual(tickertapeStatementsForPeriod("QUARTERLY"), ["INCOME"]);
  });

  it("is DERIVED from the key map, not written out beside it", () => {
    // A statement whose key map is empty cannot resolve one column, so
    // persisting it can only ever create an all-null row. Deriving means adding
    // quarterly balance-sheet keys automatically enables the statement, and
    // removing keys automatically disables it.
    for (const periodType of ["ANNUAL", "QUARTERLY"] as const) {
      for (const statement of tickertapeStatementsForPeriod(periodType)) {
        assert.ok(
          Object.keys(TICKERTAPE_STATEMENT_KEYS[periodType][statement]).length >
            0,
          `${periodType}.${statement} is served but has no keys`,
        );
      }
    }
    assert.equal(
      tickertapeStatementsForPeriod("QUARTERLY").includes("BALANCE_SHEET"),
      false,
    );
  });
});

describe("the fabricated quarter, reproduced from a REAL annual row", () => {
  it("an ANNUAL row read with the QUARTERLY key map yields an FY label and ZERO columns", () => {
    // This is exactly what `getOrFetchFinancials(…, "QUARTERLY")` used to
    // persist: a row keyed `periodType: "QUARTERLY", period: "FY 2025"` whose
    // every numeric column is unresolved, stamped `source: "TICKERTAPE"`.
    const annualRow = fy(INCOME, "FY 2025");
    const mapped = mapTickertapeStatementRow("INCOME", annualRow, "QUARTERLY");

    assert.ok(
      mapped,
      "the row maps — which is what makes the fabrication land",
    );
    assert.equal(
      mapped.period,
      "FY 2025",
      "an ANNUAL label would be stored as a QUARTER",
    );
    const columns = tickertapeStatementColumns(mapped) as Record<
      string,
      unknown
    >;
    const { periodEnd, ...numeric } = columns;
    assert.deepEqual(
      numeric,
      {},
      "no numeric column resolves: the QUARTERLY map reads qIncTrev, the row carries incTrev",
    );

    // And the row is not even obviously broken on inspection: it carries a
    // well-formed `periodEnd` of 31-Mar-2025, so what lands in
    // `stock_financials` is a "quarter" with a real-looking end date, a
    // financial-year label and no numbers at all.
    assert.equal((periodEnd as Date).toISOString(), "2025-03-31T00:00:00.000Z");
  });

  it("the same row read with the ANNUAL key map resolves its columns", () => {
    // The control. Proves the emptiness above is the key-map mismatch and not
    // a defect in the fixture or the mapper.
    const annualRow = fy(INCOME, "FY 2025");
    const mapped = mapTickertapeStatementRow("INCOME", annualRow, "ANNUAL")!;
    const columns = tickertapeStatementColumns(mapped);
    assert.ok(
      Object.keys(columns).length >= 4,
      `expected the annual map to resolve columns, got ${JSON.stringify(columns)}`,
    );
  });

  it("a REAL interim row read with the QUARTERLY key map resolves its columns", () => {
    // And the other control: the interim feed IS mappable, so routing the
    // quarterly branch at the correct endpoint produces real rows.
    const interimRow = INTERIM.find((r) => r.displayPeriod === "JUN 2025")!;
    const mapped = mapTickertapeStatementRow(
      "INCOME",
      interimRow,
      "QUARTERLY",
    )!;
    assert.equal(mapped.period, "JUN 2025");
    const columns = tickertapeStatementColumns(mapped);
    assert.ok(
      Object.keys(columns).length >= 4,
      `expected the quarterly map to resolve columns, got ${JSON.stringify(columns)}`,
    );
  });
});

describe("db-store no longer fetches Tickertape at all (MONEY-1220)", () => {
  // INVERTED, not deleted. This block used to assert that `getOrFetchFinancials`
  // routed QUARTERLY at the interim endpoint and ANNUAL at the annual one —
  // MONEY-1205's fix, which mattered because calling the annual fetcher for a
  // quarterly request persisted ANNUAL rows labelled `periodType: "QUARTERLY"`
  // with every column null.
  //
  // That routing is now unreachable: the whole fetch-and-persist path is gone.
  // Tickertape returns 403 to our Cloud Run egress, so on a request it bought
  // nothing but a doomed round trip, and a READ PATH MUST NOT WRITE —
  // `StockFinancials` has no `source` in its unique key, so a request-time write
  // from the weakest source could occupy a period the nightly XBRL projection
  // then has to displace.
  //
  // Kept as the inverse so the removal is asserted rather than merely absent:
  // if someone reinstates the fetch, this goes red and points at why it went.
  // The MAPPER tests above are untouched and still run against captured rows —
  // the mapper is still used by the research agent's on-demand tools.
  const SRC = readSource(
    new URL("../src/data-sources/db-store.ts", import.meta.url),
    "utf8",
  );

  it("makes no Tickertape call on the read path", () => {
    const fn = SRC.slice(
      SRC.indexOf("export async function getOrFetchFinancials"),
      SRC.indexOf(
        "\nexport ",
        SRC.indexOf("export async function getOrFetchFinancials") + 10,
      ),
    );
    assert.ok(fn.length > 0, "getOrFetchFinancials not found");
    assert.doesNotMatch(fn, /fetchTickertapeQuarterlyResults/);
    assert.doesNotMatch(fn, /fetchTickertapeFinancials/);
    assert.doesNotMatch(fn, /resolveTickertapeSid/);
  });

  it("serves the stored row instead, stale or not", () => {
    // A stale real number beats a failed fetch, and beats a silent empty by
    // more. The refresher is the nightly xbrl-projection job — not something a
    // request can trigger — so "stale" is no longer a reason to go anywhere.
    assert.match(SRC, /isStale\(newest\.fetchedAt, stalenessKey\)/);
    assert.match(SRC, /serving the stored copy/);
  });
});
