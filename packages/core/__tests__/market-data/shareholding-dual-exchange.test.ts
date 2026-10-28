/**
 * MONEY-1207 fallout: `shareholding_patterns` is unique on
 * `(symbol, exchange, quarter)`, so a symbol listed on BOTH exchanges has the
 * same quarter twice — once per filing. Every reader is symbol-scoped (an
 * exchange predicate would hide quarters only one exchange filed), so the
 * duplicate reaches the consumers.
 *
 * Undeduped it does not surface as "two rows"; it surfaces as a wrong answer
 * shaped like a right one — a QoQ delta of exactly 0 between a quarter and
 * itself. These tests pin the dedupe and that consequence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeShareholdingByQuarter,
  buildShareholdingSection,
  SHAREHOLDING_EXCHANGE_AUTHORITY,
} from "../../src/market-data/ownership-section-logic";

/** AARTIIND as measured on prod 2026-08-19: 2026-06 and 2026-03 dual-filed. */
const DUAL_LISTED = [
  { quarter: "2026-06", exchange: "NSE", promoterPct: 41.82, fiiPct: 6.1 },
  { quarter: "2026-06", exchange: "BSE", promoterPct: 41.82, fiiPct: 6.1 },
  { quarter: "2026-03", exchange: "NSE", promoterPct: 42.09, fiiPct: 5.4 },
  { quarter: "2026-03", exchange: "BSE", promoterPct: 42.09, fiiPct: 5.4 },
  { quarter: "2025-12", exchange: "NSE", promoterPct: 42.14, fiiPct: 5.0 },
];

describe("dedupeShareholdingByQuarter", () => {
  it("collapses a dual-filed quarter to one row", () => {
    const out = dedupeShareholdingByQuarter(DUAL_LISTED);
    assert.deepEqual(
      out.map((r) => r.quarter),
      ["2026-06", "2026-03", "2025-12"],
    );
  });

  it("prefers the requested exchange when both filed", () => {
    const out = dedupeShareholdingByQuarter(DUAL_LISTED, "BSE");
    assert.equal(out.find((r) => r.quarter === "2026-06")?.exchange, "BSE");
    // A quarter only NSE filed still survives — the preference is a tiebreak,
    // not a filter. This is the whole reason the query is not exchange-scoped.
    assert.equal(out.find((r) => r.quarter === "2025-12")?.exchange, "NSE");
  });

  it("falls back to the declared authority order with no preference", () => {
    assert.equal(SHAREHOLDING_EXCHANGE_AUTHORITY[0], "NSE");
    const bseFirst = [DUAL_LISTED[1], DUAL_LISTED[0]];
    assert.equal(dedupeShareholdingByQuarter(bseFirst)[0].exchange, "NSE");
  });

  it("is case- and whitespace-insensitive on the exchange", () => {
    const messy = [
      { quarter: "2026-06", exchange: " bse " },
      { quarter: "2026-06", exchange: "nse" },
    ];
    assert.equal(
      dedupeShareholdingByQuarter(messy, "BSE")[0].exchange,
      " bse ",
    );
  });

  it("keeps an unknown exchange rather than dropping the quarter", () => {
    const out = dedupeShareholdingByQuarter([
      { quarter: "2026-06", exchange: "MSEI" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].exchange, "MSEI");
  });

  it("ranks an unknown exchange BELOW every listed one", () => {
    // An unlisted exchange must sink, not float. Ranking it -1 (the value a
    // naive indexOf returns) would make it outrank NSE and quietly promote an
    // unvetted feed to primary the day one appears.
    const out = dedupeShareholdingByQuarter([
      { quarter: "2026-06", exchange: "MSEI" },
      { quarter: "2026-06", exchange: "NSE" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].exchange, "NSE");
  });

  it("survives a missing exchange (pre-1207 rows have none selected)", () => {
    const out = dedupeShareholdingByQuarter([
      { quarter: "2026-06" },
      { quarter: "2026-06" },
    ]);
    assert.equal(out.length, 1);
  });

  it("keeps the FIRST of two equally-ranked rows, not the last", () => {
    // Ties are broken by arrival, so the pick tracks the caller's `orderBy`
    // instead of whichever row the driver happened to hand over last. A
    // `<=` comparison here would make the result depend on DB row order.
    const tied = [
      { quarter: "2026-06", exchange: "MSEI", promoterPct: 1 },
      { quarter: "2026-06", exchange: "MSEI", promoterPct: 2 },
    ];
    assert.equal(dedupeShareholdingByQuarter(tied)[0].promoterPct, 1);
    // Same for rows carrying no exchange at all.
    const noEx = [
      { quarter: "2026-06", promoterPct: 1 },
      { quarter: "2026-06", promoterPct: 2 },
    ];
    assert.equal(dedupeShareholdingByQuarter(noEx)[0].promoterPct, 1);
  });

  it("drops blank quarters instead of grouping them together", () => {
    const out = dedupeShareholdingByQuarter([
      { quarter: "  ", exchange: "NSE" },
      { quarter: "2026-06", exchange: "NSE" },
    ]);
    assert.deepEqual(
      out.map((r) => r.quarter),
      ["2026-06"],
    );
  });

  it("preserves input order for distinct quarters", () => {
    const out = dedupeShareholdingByQuarter([
      { quarter: "2025-12", exchange: "NSE" },
      { quarter: "2026-06", exchange: "NSE" },
    ]);
    assert.deepEqual(
      out.map((r) => r.quarter),
      ["2025-12", "2026-06"],
    );
  });
});

describe("buildShareholdingSection — dual-exchange", () => {
  it("renders each quarter once", () => {
    const section = buildShareholdingSection({
      nse: DUAL_LISTED,
      tickertape: [],
    });
    const labels = section.quarters.map((q) => q.quarter);
    assert.deepEqual(new Set(labels).size, labels.length, "duplicate quarter");
    assert.equal(labels.length, 3);
  });

  it("does NOT compute a QoQ delta between a quarter and itself", () => {
    // The defect this whole change exists for: with 2026-06 present twice, the
    // newest two rows are the same period, so every delta reads as a real,
    // confident "no movement".
    const section = buildShareholdingSection({
      nse: DUAL_LISTED,
      tickertape: [],
    });
    const newest = section.quarters[0];
    assert.equal(newest.quarter, "2026-06");
    // 42.09 -> 41.82 is a genuine fall; a self-comparison would yield 0.
    assert.ok(
      newest.deltas.promoterPct !== null && newest.deltas.promoterPct !== 0,
      `expected a real QoQ delta, got ${String(newest.deltas.promoterPct)}`,
    );
    assert.ok(newest.deltas.promoterPct < 0, "promoter fell 42.09 -> 41.82");
  });

  it("honours preferExchange end-to-end", () => {
    const divergent = [
      { quarter: "2026-06", exchange: "NSE", promoterPct: 41.82 },
      { quarter: "2026-06", exchange: "BSE", promoterPct: 40.0 },
      { quarter: "2026-03", exchange: "NSE", promoterPct: 30.0 },
    ];
    const bse = buildShareholdingSection({
      nse: divergent,
      tickertape: [],
      preferExchange: "BSE",
    });
    assert.equal(bse.quarters[0].promoterPct, 40.0);
    const nse = buildShareholdingSection({ nse: divergent, tickertape: [] });
    assert.equal(nse.quarters[0].promoterPct, 41.82);
  });
});
