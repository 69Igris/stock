/**
 * FII/DII flow parser — MONEY-1108 (P8d).
 *
 * The parser is the falsifiable half of the feature: which payload shapes are
 * accepted, which rows are DROPPED, and what never reaches the database.
 *
 * The dropping is the part worth pinning. A flow row we cannot interpret is
 * worse than no row — it renders on a sentiment panel as a real institutional
 * figure — and the recurring way that goes wrong in this codebase is a
 * non-finite number surviving a parse and poisoning every sum downstream. So
 * every "returns null / skips the row" case below is a regression guard, not a
 * completeness exercise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseFiiDiiReport,
  parseNseFlowDate,
  normalizeFlowCategory,
  parseFlowValue,
  dedupeFlowRows,
  INSTITUTIONAL_FLOW_SOURCES,
  type InstitutionalFlowRow,
} from "../../src/market-data/institutional-flows";

const DAY = new Date(Date.UTC(2026, 7, 13)); // 2026-08-13

describe("parseNseFlowDate", () => {
  it("parses NSE's DD-Mon-YYYY to UTC midnight of that IST day", () => {
    assert.deepEqual(
      parseNseFlowDate("13-Aug-2026"),
      new Date(Date.UTC(2026, 7, 13)),
    );
  });

  it("accepts the space-separated and ISO spellings NSE also serves", () => {
    assert.deepEqual(
      parseNseFlowDate("13 Aug 2026"),
      new Date(Date.UTC(2026, 7, 13)),
    );
    assert.deepEqual(
      parseNseFlowDate("2026-08-13"),
      new Date(Date.UTC(2026, 7, 13)),
    );
  });

  it("is case-insensitive on the month and tolerates a full month name", () => {
    assert.deepEqual(
      parseNseFlowDate("01-SEP-2026"),
      new Date(Date.UTC(2026, 8, 1)),
    );
    assert.deepEqual(
      parseNseFlowDate("01-September-2026"),
      new Date(Date.UTC(2026, 8, 1)),
    );
  });

  it("REJECTS an impossible day instead of letting Date.UTC roll it over", () => {
    // Date.UTC(2026, 1, 31) silently becomes 3 March. Rolling over would land a
    // day's flows on the wrong trading day and corrupt every streak built on
    // the series, so the round-trip check must reject it.
    assert.equal(parseNseFlowDate("31-Feb-2026"), null);
    assert.equal(parseNseFlowDate("32-Aug-2026"), null);
    assert.equal(parseNseFlowDate("00-Aug-2026"), null);
  });

  it("returns null rather than guessing on junk", () => {
    for (const bad of [
      "",
      "   ",
      "13-Xyz-2026",
      "not a date",
      null,
      undefined,
    ]) {
      assert.equal(parseNseFlowDate(bad), null, JSON.stringify(bad));
    }
  });

  it("orders chronologically — the bug a string sort would reintroduce", () => {
    // "02-Sep-2026".localeCompare("13-Aug-2026") is NEGATIVE, i.e. a string
    // sort puts September BEFORE August. Parsing to a real Date is what makes
    // the ordering correct.
    const sep = parseNseFlowDate("02-Sep-2026")!;
    const aug = parseNseFlowDate("13-Aug-2026")!;
    assert.ok(sep.getTime() > aug.getTime());
    assert.ok("02-Sep-2026".localeCompare("13-Aug-2026") < 0);
  });
});

describe("normalizeFlowCategory", () => {
  it("collapses NSE's decorated labels to FII / DII", () => {
    assert.equal(normalizeFlowCategory("FII/FPI *"), "FII");
    assert.equal(normalizeFlowCategory("DII **"), "DII");
    assert.equal(normalizeFlowCategory("fii"), "FII");
  });

  it("treats FPI as FII — the same money under two regulatory names", () => {
    assert.equal(normalizeFlowCategory("FPI"), "FII");
  });

  it("returns null for an unknown category — the row is then dropped", () => {
    for (const bad of ["", "   ", "PRO", "CLIENT", null, undefined]) {
      assert.equal(normalizeFlowCategory(bad), null, JSON.stringify(bad));
    }
  });
});

describe("parseFlowValue", () => {
  it("strips NSE's comma grouping", () => {
    assert.equal(parseFlowValue("1,234.56"), 1234.56);
    assert.equal(parseFlowValue("12,34,567.89"), 1234567.89);
  });

  it("accepts a bare number and a negative net", () => {
    assert.equal(parseFlowValue(4321.5), 4321.5);
    assert.equal(parseFlowValue("-1,000.25"), -1000.25);
  });

  it("returns NULL, never 0, on anything unparseable", () => {
    // The distinction that matters: 0 is a CLAIM ("institutions traded
    // nothing"), and a parse failure must not be allowed to make it. A 0 here
    // would flow into net-flow streaks and monthly aggregates as real data.
    for (const bad of ["", "  ", "N/A", "-", "abc", null, undefined, {}]) {
      assert.equal(parseFlowValue(bad), null, JSON.stringify(bad));
    }
  });

  it("rejects non-finite numbers — the money-poison guard", () => {
    assert.equal(parseFlowValue(Number.NaN), null);
    assert.equal(parseFlowValue(Number.POSITIVE_INFINITY), null);
    assert.equal(parseFlowValue("Infinity"), null);
  });
});

describe("parseFiiDiiReport", () => {
  const bareArray = [
    {
      date: "13-Aug-2026",
      category: "FII/FPI *",
      buyValue: "12,345.67",
      sellValue: "11,000.00",
      netValue: "1,345.67",
    },
    {
      date: "13-Aug-2026",
      category: "DII **",
      buyValue: "9,000.00",
      sellValue: "9,500.50",
      netValue: "-500.50",
    },
  ];

  it("parses the BARE ARRAY envelope", () => {
    const out = parseFiiDiiReport(bareArray, DAY);
    assert.equal(out.rows.length, 2);
    assert.equal(out.skipped, 0);

    const fii = out.rows.find((r) => r.category === "FII")!;
    assert.deepEqual(fii.date, new Date(Date.UTC(2026, 7, 13)));
    assert.equal(fii.buyValue, 12345.67);
    assert.equal(fii.sellValue, 11000);
    assert.equal(fii.netValue, 1345.67);
    assert.equal(fii.segment, "CASH");
    assert.equal(fii.source, INSTITUTIONAL_FLOW_SOURCES.nseCash);

    const dii = out.rows.find((r) => r.category === "DII")!;
    assert.equal(dii.netValue, -500.5);
  });

  it("parses the { data: [...] } envelope identically", () => {
    // BOTH shapes are accepted on purpose — NSE's actual envelope could not be
    // verified from our dev egress (Akamai "Access Denied"), and the existing
    // research client reads `raw.data` while the endpoint's public behaviour is
    // a bare array. Picking one would make a wrong guess look like a holiday.
    const wrapped = parseFiiDiiReport({ data: bareArray }, DAY);
    const bare = parseFiiDiiReport(bareArray, DAY);
    assert.deepEqual(wrapped.rows, bare.rows);
  });

  it("yields no rows for an envelope that is neither shape", () => {
    for (const junk of [null, undefined, 42, "text", { rows: [] }, {}]) {
      const out = parseFiiDiiReport(junk, DAY);
      assert.equal(out.rows.length, 0, JSON.stringify(junk));
    }
  });

  it("DROPS and counts a row with an unknown category", () => {
    const out = parseFiiDiiReport(
      [{ date: "13-Aug-2026", category: "PRO", buyValue: "1", sellValue: "2" }],
      DAY,
    );
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 1);
  });

  it("DROPS and counts a row whose money does not parse", () => {
    const out = parseFiiDiiReport(
      [
        { date: "13-Aug-2026", category: "FII", buyValue: "-", sellValue: "2" },
        { date: "13-Aug-2026", category: "DII", buyValue: "1", sellValue: "" },
      ],
      DAY,
    );
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 2);
  });

  it("never emits a non-finite money field", () => {
    // The invariant the DB depends on. Whatever the payload does, no NaN or
    // Infinity may reach a Float column.
    const out = parseFiiDiiReport(
      [
        { date: "13-Aug-2026", category: "FII", buyValue: "1", sellValue: "2" },
        {
          date: "13-Aug-2026",
          category: "DII",
          buyValue: Number.NaN,
          sellValue: 1,
        },
        { date: "13-Aug-2026", category: "FII", buyValue: 1, sellValue: "abc" },
      ],
      DAY,
    );
    for (const row of out.rows) {
      assert.ok(Number.isFinite(row.buyValue), "buyValue");
      assert.ok(Number.isFinite(row.sellValue), "sellValue");
      assert.ok(Number.isFinite(row.netValue), "netValue");
    }
  });

  it("derives net from buy − sell when NSE omits it", () => {
    const out = parseFiiDiiReport(
      [
        {
          date: "13-Aug-2026",
          category: "FII",
          buyValue: "100",
          sellValue: "40",
        },
      ],
      DAY,
    );
    assert.equal(out.rows[0]!.netValue, 60);
  });

  it("PREFERS NSE's published net over the derived identity", () => {
    // Deriving unconditionally would silently discard a publisher correction;
    // the published figure is authoritative for its own rounding.
    const out = parseFiiDiiReport(
      [
        {
          date: "13-Aug-2026",
          category: "FII",
          buyValue: "100",
          sellValue: "40",
          netValue: "59.99",
        },
      ],
      DAY,
    );
    assert.equal(out.rows[0]!.netValue, 59.99);
  });

  it("falls back to the caller's day only when the row carries no usable date", () => {
    // This is what keeps an ARCHIVED response replayable: the row's own date
    // wins whenever it has one, so re-parsing yesterday's bytes tomorrow does
    // not stamp them with tomorrow's date.
    const out = parseFiiDiiReport(
      [
        { category: "FII", buyValue: "1", sellValue: "2" },
        { date: "01-Jul-2026", category: "DII", buyValue: "1", sellValue: "2" },
      ],
      DAY,
    );
    assert.deepEqual(out.rows[0]!.date, DAY);
    assert.deepEqual(out.rows[1]!.date, new Date(Date.UTC(2026, 6, 1)));
  });

  it("keeps a multi-day window as distinct rows", () => {
    const out = parseFiiDiiReport(
      [
        { date: "12-Aug-2026", category: "FII", buyValue: "1", sellValue: "2" },
        { date: "13-Aug-2026", category: "FII", buyValue: "3", sellValue: "4" },
      ],
      DAY,
    );
    assert.equal(out.rows.length, 2);
    assert.notEqual(out.rows[0]!.date.getTime(), out.rows[1]!.date.getTime());
  });
});

describe("dedupeFlowRows", () => {
  const row = (
    over: Partial<InstitutionalFlowRow> = {},
  ): InstitutionalFlowRow => ({
    date: DAY,
    category: "FII",
    segment: "CASH",
    buyValue: 1,
    sellValue: 2,
    netValue: -1,
    source: INSTITUTIONAL_FLOW_SOURCES.nseCash,
    ...over,
  });

  it("collapses a repeated (date, category, segment), LAST one winning", () => {
    // The DB unique would reject the whole write otherwise, turning one
    // duplicated row into a zero-row day.
    const out = dedupeFlowRows([row({ buyValue: 1 }), row({ buyValue: 9 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.buyValue, 9);
  });

  it("does NOT sum duplicates — they are one reading restated", () => {
    const out = dedupeFlowRows([row({ buyValue: 5 }), row({ buyValue: 5 })]);
    assert.equal(out[0]!.buyValue, 5);
  });

  it("keeps rows that differ in date, category or segment", () => {
    const out = dedupeFlowRows([
      row(),
      row({ category: "DII" }),
      row({ date: new Date(Date.UTC(2026, 7, 12)) }),
      row({ segment: "FNO" }),
    ]);
    assert.equal(out.length, 4);
  });

  it("is a no-op on an empty list", () => {
    assert.deepEqual(dedupeFlowRows([]), []);
  });
});
