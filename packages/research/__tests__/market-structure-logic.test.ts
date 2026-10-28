/**
 * MONEY-1204 (P14 / 14e.2) — market-structure research logic, PURE layer.
 *
 * The load-bearing cases:
 *
 *   1. `MarketPositioning` now holds TWO INCOMPATIBLE GRAINS. A read that does
 *      not filter on `metric` mixes open interest (a STOCK) with volume (a
 *      FLOW), and inside `FII_STATS` the parent bucket IS the sum of its
 *      per-underlying children — so summing both double-counts every index.
 *      `sumPositioning` REFUSES both mistakes with a reason rather than
 *      returning a plausible number.
 *   2. India VIX prints five trailing `-` because a volatility index has no
 *      basket to value. Those five must stay `null`; a rendered 0 P/E reads as
 *      a screaming-cheap index.
 *   3. `dbFirstWithLiveFallback` ordering — DB first, live only on empty, and
 *      an EMPTY CITED result rather than an error when neither answers.
 *   4. BigInt coercion, `-`/blank ⇒ null, and never 0.
 *
 * Source: packages/research/src/data-sources/market-structure-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FII_STATS_METRIC } from "@usemoney/core/market-data";

import {
  dbFirstWithLiveFallback,
  emptyCited,
  latestPerSeries,
  newestAsOf,
  normalizeIsin,
  num,
  selectPositioningRows,
  summarizeVix,
  sumPositioning,
  text,
  toBondQuoteRow,
  toDealRow,
  toFlowRow,
  toFundHoldingRow,
  toMacroRow,
  toPositioningRow,
  toStockFlagRowOut,
  toVixRow,
  type CitedRows,
  type PositioningRow,
} from "../src/data-sources/market-structure-logic";

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function positioning(
  overrides: Partial<Record<string, unknown>>,
): PositioningRow {
  const row = toPositioningRow({
    date: day("2026-08-13"),
    participant: "FII",
    bucket: "IDX_FUT",
    metric: FII_STATS_METRIC,
    longQty: 100,
    shortQty: 40,
    netQty: 60,
    longValue: null,
    shortValue: null,
    netValue: null,
    openInterestQty: null,
    openInterestValue: null,
    source: "nse-fii-stats",
    ...overrides,
  });
  assert.ok(row);
  return row!;
}

// ════════════════════════════════════════════════════════════════════
// Primitives
// ════════════════════════════════════════════════════════════════════

describe("absence primitives", () => {
  it("`num` coerces bigint and rejects everything unmeasurable", () => {
    assert.equal(num(7n), 7);
    assert.equal(num(1.5), 1.5);
    assert.equal(num(0), 0, "a reported zero is a value");
    assert.equal(num(null), null);
    assert.equal(num(NaN), null);
    assert.equal(num("8"), null);
  });

  it("`text` treats '' and '-' as ABSENCE, never as a value", () => {
    assert.equal(text("CBM"), "CBM");
    assert.equal(text("  WDM  "), "WDM");
    assert.equal(text(""), null);
    assert.equal(text("-"), null);
    assert.equal(text(null), null);
  });

  it("`normalizeIsin` trims and upper-cases — the cbm_trd trailing-space trap", () => {
    // `cbm_trd` prints "INE261F08EO7 " and `wdmlist` prints "INE261F08EO7".
    // An un-normalised join matches nothing, which looks exactly like "this
    // bond does not trade".
    assert.equal(normalizeIsin("INE261F08EO7 "), "INE261F08EO7");
    assert.equal(normalizeIsin("ine261f08eo7"), "INE261F08EO7");
    assert.equal(normalizeIsin(""), null);
  });

  it("`newestAsOf` reports the newest ROW date, not the fetch time", () => {
    assert.equal(
      newestAsOf([
        { date: "2026-08-01" },
        { date: "2026-08-14" },
        { date: null },
      ]),
      "2026-08-14",
    );
    assert.equal(newestAsOf([]), null);
  });
});

// ════════════════════════════════════════════════════════════════════
// 1. Positioning — metric filter + grain refusal
// ════════════════════════════════════════════════════════════════════

describe("positioning — the metric filter", () => {
  const rows = [
    positioning({ metric: "OI", bucket: "FUT_IDX", netQty: 1000 }),
    positioning({ metric: "VOLUME", bucket: "FUT_IDX", netQty: 50_000 }),
    positioning({ metric: FII_STATS_METRIC, bucket: "IDX_FUT", netQty: 900 }),
  ];

  it("selects ONE metric and drops the others", () => {
    const oi = selectPositioningRows(rows, { metric: "OI" });
    assert.equal(oi.length, 1);
    assert.equal(oi[0]!.netQty, 1000);

    const stats = selectPositioningRows(rows, { metric: FII_STATS_METRIC });
    assert.equal(stats.length, 1);
    assert.equal(stats[0]!.netQty, 900);
  });

  it("marks FII_STATS breakdowns by the ':' convention, and nothing else", () => {
    const total = positioning({ bucket: "IDX_OPT" });
    const breakdown = positioning({ bucket: "IDX_OPT:NIFTY" });
    assert.equal(total.isTotal, true);
    assert.equal(breakdown.isTotal, false);

    // The participant feed's buckets are leaves; the ':' rule is FII_STATS's
    // alone, so an OI row is always a total.
    const oi = positioning({ metric: "OI", bucket: "OPT_IDX_CALL" });
    assert.equal(oi.isTotal, true);
  });

  it("defaults to TOTALS, and BREAKDOWNS/ALL are opt-in", () => {
    const mixed = [
      positioning({ bucket: "IDX_OPT", netQty: 300 }),
      positioning({ bucket: "IDX_OPT:NIFTY", netQty: 200 }),
      positioning({ bucket: "IDX_OPT:BANKNIFTY", netQty: 100 }),
    ];
    assert.equal(
      selectPositioningRows(mixed, { metric: FII_STATS_METRIC }).length,
      1,
    );
    assert.equal(
      selectPositioningRows(mixed, {
        metric: FII_STATS_METRIC,
        grain: "BREAKDOWNS",
      }).length,
      2,
    );
    assert.equal(
      selectPositioningRows(mixed, { metric: FII_STATS_METRIC, grain: "ALL" })
        .length,
      3,
    );
  });
});

describe("sumPositioning — refuses the two ways this table lies", () => {
  it("CATCHES mixed metrics instead of adding a stock to a flow", () => {
    const result = sumPositioning([
      positioning({ metric: "OI", bucket: "FUT_IDX", netQty: 1000 }),
      positioning({ metric: "VOLUME", bucket: "FUT_IDX", netQty: 50_000 }),
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "MIXED_METRICS");
    assert.match(
      result.ok === false ? result.detail : "",
      /open interest is a stock/i,
    );
  });

  it("CATCHES totals summed with their own breakdowns", () => {
    // `IDX_OPT` IS the exact sum of its per-underlying children (verified on
    // the 2026-08-13 file to NSE's own ±0.01 rounding), so this set
    // double-counts every index.
    const rows = [
      positioning({ bucket: "IDX_OPT", netQty: 300 }),
      positioning({ bucket: "IDX_OPT:NIFTY", netQty: 200 }),
      positioning({ bucket: "IDX_OPT:BANKNIFTY", netQty: 100 }),
    ];
    const result = sumPositioning(rows);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "MIXED_GRAIN");

    // The number the refusal prevents: 600, which is exactly twice the truth
    // and looks entirely plausible.
    const naive = rows.reduce((s, r) => s + (r.netQty ?? 0), 0);
    assert.equal(naive, 600);

    // Either grain ALONE sums correctly to 300.
    const totals = sumPositioning(
      selectPositioningRows(rows, {
        metric: FII_STATS_METRIC,
        grain: "TOTALS",
      }),
    );
    assert.equal(totals.ok && totals.sum.netQty, 300);
    const breakdowns = sumPositioning(
      selectPositioningRows(rows, {
        metric: FII_STATS_METRIC,
        grain: "BREAKDOWNS",
      }),
    );
    assert.equal(breakdowns.ok && breakdowns.sum.netQty, 300);
  });

  it("does NOT apply the grain rule outside FII_STATS", () => {
    // The participant feed's six legs are all leaves; refusing there would
    // block a legitimate sum.
    const result = sumPositioning([
      positioning({ metric: "OI", bucket: "FUT_IDX", netQty: 10 }),
      positioning({ metric: "OI", bucket: "FUT_STK", netQty: 20 }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.sum.netQty, 30);
  });

  it("returns a NULL rupee total when no row published one", () => {
    // The participant files publish contract COUNTS and no lot size, so a
    // notional cannot be derived. Null says that; 0 would claim it is zero.
    const counts = sumPositioning([
      positioning({
        metric: "OI",
        bucket: "FUT_IDX",
        netQty: 10,
        netValue: null,
      }),
      positioning({
        metric: "OI",
        bucket: "FUT_STK",
        netQty: 20,
        netValue: null,
      }),
    ]);
    assert.equal(counts.ok && counts.sum.netValue, null);

    const withValue = sumPositioning([
      positioning({ bucket: "IDX_FUT", netQty: 10, netValue: 12.5 }),
      positioning({ bucket: "STK_FUT", netQty: 20, netValue: 7.5 }),
    ]);
    assert.equal(withValue.ok && withValue.sum.netValue, 20);
  });

  it("refuses an empty set rather than reporting a zero position", () => {
    const result = sumPositioning([]);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "EMPTY");
  });

  it("carries a real published zero through — 0 is not absence", () => {
    // NIFTYFPI futures printed 0 / 0.00 on 13-Aug-2026.
    const result = sumPositioning([
      positioning({ bucket: "IDX_FUT:NIFTYFPI", netQty: 0, netValue: 0 }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.sum.netQty, 0);
    assert.equal(
      result.ok && result.sum.netValue,
      0,
      "a published 0, not null",
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. India VIX
// ════════════════════════════════════════════════════════════════════

describe("India VIX — the five trailing dashes stay null", () => {
  // The real archived line:
  //   India VIX,14-08-2026,11.4175,11.56,10.825,11.31,-,-,-,-,-
  const archived = {
    date: day("2026-08-14"),
    open: 11.4175,
    high: 11.56,
    low: 10.825,
    close: 11.31,
    prevClose: 11.5,
    volume: null,
    turnoverCr: null,
    pe: null,
    pb: null,
    divYield: null,
  };

  it("maps the OHLC and leaves the unvaluable columns null", () => {
    const row = toVixRow(archived);
    assert.ok(row);
    assert.equal(row!.open, 11.4175);
    assert.equal(row!.close, 11.31);
    for (const k of ["volume", "turnoverCr", "pe", "pb", "divYield"] as const) {
      assert.equal(row![k], null, `${k} must be null, never 0`);
      assert.notEqual(row![k], 0);
    }
  });

  it("summarises over sessions that reported a close, skipping any that did not", () => {
    const rows = [
      toVixRow({ ...archived, close: 12 })!,
      toVixRow({ ...archived, date: day("2026-08-13"), close: null })!,
      toVixRow({ ...archived, date: day("2026-08-12"), close: 10 })!,
    ];
    const s = summarizeVix(rows);
    assert.equal(s.latest, 12);
    assert.equal(s.n, 2, "the null session did not contribute");
    assert.equal(s.mean, 11);
    assert.equal(s.min, 10);
    assert.equal(s.max, 12);
    assert.equal(s.vsMean, 1);
  });

  it("an all-null window yields null stats, not zeros", () => {
    const s = summarizeVix([toVixRow({ ...archived, close: null })!]);
    assert.equal(s.latest, null);
    assert.equal(s.mean, null);
    assert.equal(s.n, 0);
    assert.equal(s.vsMean, null);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. DB-first with live fallback
// ════════════════════════════════════════════════════════════════════

interface Row {
  id: string;
}

const citedDb = (rows: Row[]): CitedRows<Row> => ({
  rows,
  asOf: rows.length ? "2026-08-14" : null,
  provenance: { origin: "DB", source: "T" },
});
const citedLive = (rows: Row[]): CitedRows<Row> => ({
  rows,
  asOf: rows.length ? "2026-08-14" : null,
  provenance: { origin: "LIVE", source: "L" },
});

describe("dbFirstWithLiveFallback", () => {
  const opts = { source: "T", emptyNote: "nothing anywhere" };

  it("returns DB rows and NEVER calls live — the happy path costs no egress", async () => {
    let liveCalls = 0;
    const out = await dbFirstWithLiveFallback<Row>(
      async () => citedDb([{ id: "a" }]),
      async () => {
        liveCalls++;
        return citedLive([{ id: "live" }]);
      },
      opts,
    );
    assert.equal(liveCalls, 0);
    assert.equal(out.provenance.origin, "DB");
    assert.deepEqual(out.rows, [{ id: "a" }]);
    assert.equal(out.provenance.fallback, undefined);
  });

  it("falls back to live when the DB is EMPTY, and says so", async () => {
    const out = await dbFirstWithLiveFallback<Row>(
      async () => citedDb([]),
      async () => citedLive([{ id: "live" }]),
      opts,
    );
    assert.equal(out.provenance.origin, "LIVE");
    assert.equal(out.provenance.fallback, true);
    assert.deepEqual(out.rows, [{ id: "live" }]);
  });

  it("falls back to live when the DB THROWS", async () => {
    const out = await dbFirstWithLiveFallback<Row>(
      async () => {
        throw new Error("prisma exploded");
      },
      async () => citedLive([{ id: "live" }]),
      opts,
    );
    assert.equal(out.provenance.origin, "LIVE");
    assert.equal(out.provenance.fallback, true);
  });

  it("both empty ⇒ an EMPTY CITED result, not an error", async () => {
    const out = await dbFirstWithLiveFallback<Row>(
      async () => citedDb([]),
      async () => citedLive([]),
      opts,
    );
    assert.deepEqual(out.rows, []);
    assert.equal(out.asOf, null);
    assert.equal(out.provenance.origin, "NONE");
    assert.equal(out.provenance.note, "nothing anywhere");
  });

  it("records the live error so an outage is distinguishable from a gap", async () => {
    const out = await dbFirstWithLiveFallback<Row>(
      async () => citedDb([]),
      async () => {
        throw new Error("NSE 403");
      },
      opts,
    );
    assert.equal(out.provenance.origin, "NONE");
    assert.equal(out.provenance.sourceError, "NSE 403");
    assert.equal(out.provenance.fallback, true);
  });

  it("with no live path at all, still returns a cited empty", async () => {
    const out = await dbFirstWithLiveFallback<Row>(
      async () => citedDb([]),
      null,
      opts,
    );
    assert.equal(out.provenance.origin, "NONE");
    assert.deepEqual(out.rows, []);
  });
});

describe("emptyCited", () => {
  it("is a finding, not an error — it carries a reason", () => {
    const out = emptyCited<Row>("BondEOD", "coverage gap");
    assert.deepEqual(out.rows, []);
    assert.equal(out.asOf, null);
    assert.equal(out.provenance.origin, "NONE");
    assert.equal(out.provenance.note, "coverage gap");
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. Row mappers
// ════════════════════════════════════════════════════════════════════

describe("row mappers", () => {
  it("coerces the deal quantity BigInt before it can reach JSON.stringify", () => {
    const row = toDealRow({
      date: day("2026-08-14"),
      symbol: "IDEA",
      exchange: "NSE",
      securityName: "Vodafone Idea",
      clientName: "SOME FUND",
      buySell: "BUY",
      qty: 1_200_000_000n,
      avgPrice: 8.4,
      dealType: "BULK",
      remarks: "-",
      source: "NSE_DEALS",
    });
    assert.ok(row);
    assert.equal(row!.qty, 1_200_000_000);
    assert.equal(typeof row!.qty, "number");
    // `-` in the remarks column means ABSENCE.
    assert.equal(row!.remarks, null);
    assert.doesNotThrow(() => JSON.stringify(row));
  });

  it("drops a deal row with no symbol or no date rather than inventing one", () => {
    assert.equal(toDealRow({ symbol: "", date: day("2026-08-14") }), null);
    assert.equal(toDealRow({ symbol: "IDEA", date: null }), null);
  });

  it("reads the published NET flow rather than re-deriving buy − sell", () => {
    const row = toFlowRow({
      date: day("2026-08-14"),
      category: "FII",
      segment: "CASH",
      buyValue: 12_000,
      sellValue: 13_000,
      // NSE's own net, which may differ from buy − sell after a correction.
      netValue: -1_050,
      source: "NSE_FII_DII_CASH",
    });
    assert.ok(row);
    assert.equal(row!.netValue, -1_050);
    assert.notEqual(row!.netValue, 12_000 - 13_000);
  });

  it("keeps the macro label VERBATIM so a rebase stays discoverable", () => {
    const row = toMacroRow({
      seriesId: "OEA_WPI_ALL_COMMODITIES",
      period: day("2026-06-01"),
      value: 155.2,
      unit: "INDEX",
      frequency: "MONTHLY",
      label: "Wholesale Price Index (2022-23=100)",
      releasedOn: day("2026-08-07"),
      source: "oea-wpi",
    });
    assert.ok(row);
    assert.equal(row!.label, "Wholesale Price Index (2022-23=100)");
    assert.equal(row!.period, "2026-06-01T00:00:00.000Z");
    assert.equal(row!.releasedOn, "2026-08-07T00:00:00.000Z");
  });

  it("latestPerSeries keeps the newest period per series", () => {
    const rows = [
      toMacroRow({
        seriesId: "A",
        period: day("2026-06-01"),
        value: 1,
        unit: "PERCENT",
        frequency: "M",
        label: "a",
      })!,
      toMacroRow({
        seriesId: "A",
        period: day("2026-07-01"),
        value: 2,
        unit: "PERCENT",
        frequency: "M",
        label: "a",
      })!,
      toMacroRow({
        seriesId: "B",
        period: day("2026-05-01"),
        value: 3,
        unit: "PERCENT",
        frequency: "M",
        label: "b",
      })!,
    ];
    const latest = latestPerSeries(rows);
    assert.deepEqual(
      latest.map((r) => [r.seriesId, r.value]),
      [
        ["A", 2],
        ["B", 3],
      ],
    );
  });

  it("keeps a fund holding whose ISIN is null — weights must still sum to 100", () => {
    const row = toFundHoldingRow({
      period: day("2026-07-01"),
      amc: "SBI",
      schemeName: "SBI Bluechip Fund",
      schemeKey: "sbibluechip",
      isin: null,
      instrumentName: "TREPS",
      holdingType: "CASH",
      quantity: null,
      marketValue: 2500.5,
      percentToNav: 1.2,
      source: "amc-sbi",
    });
    assert.ok(row);
    assert.equal(row!.isin, null);
    assert.equal(row!.quantity, null, "cash lines have no quantity");
    assert.equal(row!.marketValueLakh, 2500.5);
  });

  it("carries the bond segment and a perpetual's null maturity", () => {
    const row = toBondQuoteRow(
      {
        isin: "INE261F08EO7",
        date: day("2026-08-14"),
        segment: "WDM",
        lastPrice: 101.2,
        lastYtm: 7.88,
        wapPrice: null,
        wtdYtm: null,
        totalTradeValueLacs: 400,
        source: "wdmlist",
      },
      {
        symbol: "BOB",
        issuer: "Bank of Baroda",
        coupon: null,
        maturityDate: null,
        creditRating: "CRISIL AAA",
        secType: "PT",
      },
    );
    assert.ok(row);
    assert.equal(row!.segment, "WDM");
    // NULL maturity is MEANINGFUL — perpetual Tier-1 paper genuinely has none.
    assert.equal(row!.maturityDate, null);
    // A coupon we failed to read is not a zero-coupon bond.
    assert.equal(row!.coupon, null);
    assert.equal(row!.creditRating, "CRISIL AAA");
  });

  it("decodes a surveillance code at RENDER, over the verbatim raw", () => {
    const row = toStockFlagRowOut({
      kind: "SURVEILLANCE",
      label: "GSM Stage I",
      raw: "GSM STAGE - I",
      parsed: {
        type: "SURVEILLANCE",
        code: "GSM STAGE - I",
        decode: { framework: "GSM", stage: 1 },
      },
      date: "2026-08-14T00:00:00.000Z",
      since: "2026-08-01T00:00:00.000Z",
      observedSessions: 10,
      runReachesWindowEdge: false,
      isCurrent: true,
      series: "EQ",
      source: "nse-reg-ind",
    });
    // The stored text survives intact beside the decode.
    assert.equal(row.raw, "GSM STAGE - I");
    assert.equal(row.framework, "GSM");
    assert.equal(row.stage, 1);
  });

  it("leaves an unrecognised code undecoded rather than guessing a framework", () => {
    const row = toStockFlagRowOut({
      kind: "SURVEILLANCE",
      label: "NEW ZZZ",
      raw: "NEW ZZZ",
      parsed: { type: "SURVEILLANCE", code: "NEW ZZZ", decode: null },
      date: "2026-08-14T00:00:00.000Z",
      since: "2026-08-14T00:00:00.000Z",
      observedSessions: 1,
      runReachesWindowEdge: true,
      isCurrent: true,
      series: null,
      source: null,
    });
    assert.equal(row.framework, null);
    assert.equal(row.raw, "NEW ZZZ");
  });
});
