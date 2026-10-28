/**
 * MF portfolio section logic — MONEY-1204 (P14 / 14d.1).
 *
 * Three things here would each ship a confident wrong answer:
 *
 *  1. preferring the AI-derived fallback when the official filing looks thin;
 *  2. diffing against a calendar-previous month that was never published, which
 *     renders every holding as newly entered — the most alarming possible way to
 *     say "we have no data";
 *  3. treating an undisclosed weight as 0, which both buries a large position at
 *     the bottom of the sort and lets a partial disclosure sum to a total that
 *     looks complete.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMfPortfolioSection,
  diffMfPortfolio,
  disclosedWeight,
  latestPeriod,
  type FundHoldingRow,
  type MfPortfolioRow,
} from "../../src/market-data/mf-portfolio-section-logic";

const M = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const official = (
  period: string,
  name: string,
  pct: number | null,
): MfPortfolioRow => ({
  period: M(period),
  amc: "SBI",
  schemeKey: "SBI_BLUECHIP",
  amfiSchemeCode: "100123",
  instrumentName: name,
  isin: null,
  holdingType: "EQUITY",
  quantity: null,
  marketValue: null,
  percentToNav: pct,
  source: "amc-sbi",
});

const kuvera = (name: string, pct: number): FundHoldingRow => ({
  holdingName: name,
  holdingSymbol: null,
  isin: null,
  holdingType: "EQUITY",
  sector: null,
  weightPercent: pct,
  source: "gemini",
});

describe("buildMfPortfolioSection — precedence", () => {
  it("the official AMC filing wins when it has any rows", () => {
    const out = buildMfPortfolioSection({
      official: [official("2026-07-31", "RELIANCE", 8.1)],
      fallback: [kuvera("HDFC BANK", 9.9)],
    });
    assert.equal(out.source, "MF_PORTFOLIO");
    assert.equal(out.fallback, false);
    assert.equal(out.lines[0]?.name, "RELIANCE");
  });

  it("wins even with ONE row against a fuller fallback", () => {
    // "Any row" not "enough rows", on purpose: a genuinely small portfolio and a
    // partial parse look identical here, and quietly preferring the fallback
    // because the filing looked thin would hide a parse bug behind plausible
    // data.
    const out = buildMfPortfolioSection({
      official: [official("2026-07-31", "ITC", 2)],
      fallback: [kuvera("A", 5), kuvera("B", 5), kuvera("C", 5)],
    });
    assert.equal(out.source, "MF_PORTFOLIO");
    assert.equal(out.lines.length, 1);
  });

  it("falls back only when the official side is empty, and LABELS it", () => {
    const out = buildMfPortfolioSection({
      official: [],
      fallback: [kuvera("HDFC BANK", 9.9)],
    });
    assert.equal(out.source, "FUND_HOLDING");
    assert.equal(out.fallback, true);
  });

  it("the fallback carries NO period — null, never 'now'", () => {
    // FundHolding has no period column; it is a single overwritten snapshot.
    // Stamping it with the current date asserts a vintage it does not have.
    const out = buildMfPortfolioSection({
      official: [],
      fallback: [kuvera("X", 1)],
    });
    assert.equal(out.period, null);
  });

  it("renders only the newest month of the official data", () => {
    const out = buildMfPortfolioSection({
      official: [
        official("2026-06-30", "OLD", 5),
        official("2026-07-31", "NEW", 5),
      ],
      fallback: [],
    });
    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0]?.name, "NEW");
    assert.equal(out.period?.toISOString().slice(0, 10), "2026-07-31");
  });

  it("both empty ⇒ no source, not a fabricated one", () => {
    const out = buildMfPortfolioSection({ official: [], fallback: [] });
    assert.equal(out.source, null);
    assert.equal(out.fallback, false);
    assert.deepEqual(out.lines, []);
  });

  it("carries unresolved schemes through instead of dropping them", () => {
    // schemeKey -> AMFI code is nullable, so an unattached disclosure is a
    // NORMAL state. Showing it beats an empty tab implying the AMC published
    // nothing.
    const out = buildMfPortfolioSection({
      official: [],
      fallback: [],
      unresolvedSchemes: ["SBI Long Term Equity Fund - Direct"],
    });
    assert.deepEqual(out.unresolvedSchemes, [
      "SBI Long Term Equity Fund - Direct",
    ]);
  });
});

describe("buildMfPortfolioSection — sorting", () => {
  it("sorts heaviest first", () => {
    const out = buildMfPortfolioSection({
      official: [
        official("2026-07-31", "SMALL", 1),
        official("2026-07-31", "BIG", 9),
      ],
      fallback: [],
    });
    assert.deepEqual(
      out.lines.map((l) => l.name),
      ["BIG", "SMALL"],
    );
  });

  it("puts an UNDISCLOSED weight last, not at zero", () => {
    // Sorting null as 0 buries a potentially large undisclosed position among
    // the genuinely tiny ones.
    const out = buildMfPortfolioSection({
      official: [
        official("2026-07-31", "UNKNOWN", null),
        official("2026-07-31", "TINY", 0.01),
      ],
      fallback: [],
    });
    assert.deepEqual(
      out.lines.map((l) => l.name),
      ["TINY", "UNKNOWN"],
    );
  });

  it("a disclosed ZERO weight sorts as a real zero, above undisclosed", () => {
    const out = buildMfPortfolioSection({
      official: [
        official("2026-07-31", "UNKNOWN", null),
        official("2026-07-31", "ZERO", 0),
      ],
      fallback: [],
    });
    assert.deepEqual(
      out.lines.map((l) => l.name),
      ["ZERO", "UNKNOWN"],
    );
  });
});

describe("diffMfPortfolio — month over month", () => {
  const rows = [
    official("2026-06-30", "KEPT", 5),
    official("2026-06-30", "SOLD", 3),
    official("2026-07-31", "KEPT", 7),
    official("2026-07-31", "BOUGHT", 2),
  ];

  it("reports entered and exited against the previous PUBLISHED month", () => {
    const d = diffMfPortfolio(rows);
    assert.deepEqual(d.entered, ["BOUGHT"]);
    assert.deepEqual(d.exited, ["SOLD"]);
    assert.equal(d.period?.toISOString().slice(0, 10), "2026-07-31");
    assert.equal(d.previousPeriod?.toISOString().slice(0, 10), "2026-06-30");
  });

  it("reports a weight move on a position held in both months", () => {
    const d = diffMfPortfolio(rows);
    assert.deepEqual(d.changed, [{ name: "KEPT", from: 5, to: 7 }]);
  });

  it("compares the two most recent PUBLISHED months across a gap", () => {
    // AMC disclosures skip months. Asking for a calendar-previous month that was
    // never published would report every holding as newly entered.
    const gapped = [
      official("2026-03-31", "OLD", 4),
      official("2026-07-31", "OLD", 4),
      official("2026-07-31", "NEW", 1),
    ];
    const d = diffMfPortfolio(gapped);
    assert.equal(d.previousPeriod?.toISOString().slice(0, 10), "2026-03-31");
    assert.deepEqual(d.entered, ["NEW"]);
    assert.deepEqual(d.exited, []);
  });

  it("ONE month present ⇒ nothing entered, nothing exited", () => {
    // The alarming failure this prevents: with nothing to compare against,
    // "everything is new" is not the honest answer — "no change is known" is.
    const d = diffMfPortfolio([official("2026-07-31", "A", 1)]);
    assert.equal(d.previousPeriod, null);
    assert.deepEqual(d.entered, []);
    assert.deepEqual(d.exited, []);
    assert.deepEqual(d.changed, []);
  });

  it("no rows at all ⇒ empty, not a throw", () => {
    const d = diffMfPortfolio([]);
    assert.equal(d.period, null);
    assert.deepEqual(d.entered, []);
  });

  it("a null weight on either side is NOT reported as a weight move", () => {
    // That is a change in what was DISCLOSED, not a trade. Reporting it as a
    // move invents one.
    const d = diffMfPortfolio([
      official("2026-06-30", "X", null),
      official("2026-07-31", "X", 5),
    ]);
    assert.deepEqual(d.changed, []);
    assert.deepEqual(d.entered, []);
    assert.deepEqual(d.exited, []);
  });
});

describe("disclosedWeight", () => {
  it("totals only the disclosed lines and counts the rest", () => {
    // So the UI can say "92.4% across 2 of 3 holdings" rather than presenting
    // 92.4% as though the missing 7.6% were cash.
    const out = disclosedWeight([
      {
        name: "A",
        isin: null,
        symbol: null,
        holdingType: "EQUITY",
        weightPct: 60,
        marketValue: null,
        quantity: null,
      },
      {
        name: "B",
        isin: null,
        symbol: null,
        holdingType: "EQUITY",
        weightPct: 32.4,
        marketValue: null,
        quantity: null,
      },
      {
        name: "C",
        isin: null,
        symbol: null,
        holdingType: "EQUITY",
        weightPct: null,
        marketValue: null,
        quantity: null,
      },
    ]);
    assert.equal(Math.round(out.totalPct * 10) / 10, 92.4);
    assert.equal(out.disclosed, 2);
    assert.equal(out.undisclosed, 1);
  });

  it("treats a non-finite weight as undisclosed, not as a number", () => {
    const out = disclosedWeight([
      {
        name: "A",
        isin: null,
        symbol: null,
        holdingType: "EQUITY",
        weightPct: Number.NaN,
        marketValue: null,
        quantity: null,
      },
    ]);
    assert.equal(out.disclosed, 0);
    assert.equal(out.undisclosed, 1);
    assert.equal(out.totalPct, 0);
  });
});

describe("latestPeriod", () => {
  it("returns the newest period", () => {
    assert.equal(
      latestPeriod([
        official("2026-06-30", "A", 1),
        official("2026-07-31", "B", 1),
      ])
        ?.toISOString()
        .slice(0, 10),
      "2026-07-31",
    );
  });

  it("returns null on no rows", () => {
    assert.equal(latestPeriod([]), null);
  });
});
