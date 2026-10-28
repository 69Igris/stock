/**
 * MONEY-1255 — the provenance chip stopped lying, and the 52,435 unread rows
 * started rendering.
 *
 * Two defects, one file, because they share a fixture: a company that is on BSE
 * and NOT on NSE.
 *
 * ## 1. `buildShareholdingSection` returned a CONSTANT
 *
 * `SHAREHOLDING_PRIMARY_SOURCE` was returned whenever the exchange path was
 * taken at all, regardless of which exchange's row won the dedupe. Measured on
 * prod: `shareholding_patterns` holds 17,075 BSE rows across 4,705 symbols and
 * 2,605 of those symbols have NO NSE row — 93.4% of BSE-only names are covered
 * here. Every one of them rendered numbers taken entirely from BSE's filing
 * under a chip reading "NSE shareholding". The chip is the only thing on the
 * page that says where a number came from, so that is a false claim on screen,
 * not a cosmetic mislabel.
 *
 * The mutation this file must kill: put the constant back, and
 * `serves a BSE-only company under a BSE chip` must fail.
 *
 * ## 2. `shareholding_breakdown` was written nightly and read by nobody
 *
 * 52,435 rows across 4,828 symbols, and no user-facing code path touched one.
 * The summary table cannot substitute — `shareholding_patterns` has no
 * mutual-fund, insurance, banks, government or retail column at all.
 *
 * Every assertion below is on the PURE layer, so the arithmetic is pinned
 * without a Prisma fake: absence stays absent, a division by zero is refused
 * rather than rendered, and a BigInt leaves as a string.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SHAREHOLDING_PRIMARY_SOURCE,
  breakdownRowSource,
  buildOwnershipBreakdownSection,
  buildShareholdingSection,
  hasOwnershipBreakdownValues,
  institutionalTotal,
  relativeChangePct,
  shareCountString,
  shareholdingRowSource,
  type NseShareholdingRow,
  type OwnershipBreakdownRow,
} from "../../src/market-data/ownership-section-logic";

// ════════════════════════════════════════════════════════════════════════════
// A3.1 — the chip names the row that won
// ════════════════════════════════════════════════════════════════════════════

/**
 * NPRFIN as sampled on prod: a BSE-only micro-cap with a current-quarter row
 * and a 68.02% promoter holding. There is no NSE row for this symbol at all,
 * which is the whole point — nothing here can be served by the primary.
 */
const BSE_ONLY: NseShareholdingRow[] = [
  {
    quarter: "2026-06",
    exchange: "BSE",
    source: "BSE_SHP",
    promoterPct: 68.02,
    pledgedPct: null,
    fiiPct: 0.12,
    diiPct: null,
    publicPct: 31.86,
  },
  {
    quarter: "2026-03",
    exchange: "BSE",
    source: "BSE_SHP",
    promoterPct: 68.02,
    pledgedPct: null,
    fiiPct: 0.1,
    diiPct: null,
    publicPct: 31.88,
  },
];

describe("MONEY-1255 A3.1 — the shareholding chip names the winning row", () => {
  it("serves a BSE-only company under a BSE chip", () => {
    const out = buildShareholdingSection({ nse: BSE_ONLY, tickertape: [] });

    // The section is POPULATED — this is not the empty path wearing a label.
    assert.equal(out.quarters.length, 2);
    assert.equal(out.quarters[0]?.promoterPct, 68.02);

    assert.equal(out.source, "BSE_SHP");
    // Stated twice, on purpose. The first assertion pins the right answer; this
    // one pins the WRONG one, so re-hardcoding the constant cannot pass by
    // coincidence if "BSE_SHP" is ever renamed to the primary's value.
    assert.notEqual(
      out.source,
      SHAREHOLDING_PRIMARY_SOURCE,
      "a company with no NSE row must never be labelled with NSE's source",
    );
    // BSE is an exchange filing, not a third-party copy. The amber "fallback"
    // pill would tell the reader this is a downgrade; it is not.
    assert.equal(out.fallback, false);
    assert.deepEqual(out.sources, ["BSE_SHP"]);
  });

  it("still names NSE when NSE's row is the one that won", () => {
    const nseOnly: NseShareholdingRow[] = [
      {
        quarter: "2026-06",
        exchange: "NSE",
        source: "NSE_SHP",
        promoterPct: 50,
      },
    ];
    assert.equal(
      buildShareholdingSection({ nse: nseOnly, tickertape: [] }).source,
      "NSE_SHP",
    );
  });

  it("follows preferExchange when BOTH exchanges filed the quarter", () => {
    const dual: NseShareholdingRow[] = [
      {
        quarter: "2026-06",
        exchange: "NSE",
        source: "NSE_SHP",
        promoterPct: 41.82,
      },
      {
        quarter: "2026-06",
        exchange: "BSE",
        source: "BSE_SHP",
        promoterPct: 40,
      },
    ];
    const onBse = buildShareholdingSection({
      nse: dual,
      tickertape: [],
      preferExchange: "BSE",
    });
    // The NUMBER and the LABEL must move together. A chip that says NSE over
    // BSE's 40.0 is the same defect in the other direction.
    assert.equal(onBse.quarters[0]?.promoterPct, 40);
    assert.equal(onBse.source, "BSE_SHP");

    const onNse = buildShareholdingSection({ nse: dual, tickertape: [] });
    assert.equal(onNse.quarters[0]?.promoterPct, 41.82);
    assert.equal(onNse.source, "NSE_SHP");
  });

  it("reports the whole mix when a series is drawn from both exchanges", () => {
    // Real shape: BSE filed the newest quarter, NSE the one before, and neither
    // filed the other's. One chip cannot describe that, so `sources` does.
    const mixed: NseShareholdingRow[] = [
      {
        quarter: "2026-06",
        exchange: "BSE",
        source: "BSE_SHP",
        promoterPct: 40,
      },
      {
        quarter: "2026-03",
        exchange: "NSE",
        source: "NSE_SHP",
        promoterPct: 41,
      },
    ];
    const out = buildShareholdingSection({ nse: mixed, tickertape: [] });
    assert.equal(out.source, "BSE_SHP", "the chip names the NEWEST row");
    assert.deepEqual(out.sources, ["BSE_SHP", "NSE_SHP"]);
    // Per-quarter provenance, so the mix is checkable rather than asserted.
    assert.deepEqual(
      out.quarters.map((q) => q.source),
      ["BSE_SHP", "NSE_SHP"],
    );
  });

  it("keeps the labelled third-party treatment when NO exchange filed", () => {
    const out = buildShareholdingSection({
      nse: [],
      tickertape: [{ quarter: "Jun 2026", promoter: 49.9 }],
    });
    assert.equal(out.source, "TICKERTAPE");
    assert.equal(out.fallback, true);
    assert.deepEqual(out.sources, ["TICKERTAPE"]);
  });

  it("fabricates nothing when there is nothing", () => {
    const out = buildShareholdingSection({ nse: [], tickertape: [] });
    assert.equal(out.source, null);
    assert.equal(out.fallback, false);
    assert.deepEqual(out.sources, []);
  });
});

describe("MONEY-1255 — shareholdingRowSource", () => {
  it("prefers the stored column over the exchange", () => {
    // The column is what the WRITER recorded; the exchange is what it keyed the
    // row under. If they ever disagree, the writer's own record wins.
    assert.equal(
      shareholdingRowSource({ source: "BSE_SHP", exchange: "NSE" }),
      "BSE_SHP",
    );
  });

  it("falls back to the exchange when the column was not selected", () => {
    assert.equal(shareholdingRowSource({ exchange: "BSE" }), "BSE_SHP");
    assert.equal(shareholdingRowSource({ exchange: " nse " }), "NSE_SHP");
  });

  it("restates the schema default ONLY when the row names neither", () => {
    assert.equal(shareholdingRowSource({}), SHAREHOLDING_PRIMARY_SOURCE);
  });

  it("says 'unknown' rather than 'NSE' for an exchange it cannot code", () => {
    // The rung that makes the default safe. Without it, a future MSEI row would
    // silently claim NSE — the exact class of defect this ticket closed.
    assert.equal(shareholdingRowSource({ exchange: "MSEI" }), null);
    assert.equal(shareholdingRowSource({ source: "SOMETHING_ELSE" }), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A3.3 — the breakdown card
// ════════════════════════════════════════════════════════════════════════════

const LATEST: OwnershipBreakdownRow = {
  quarter: "2026-06",
  exchange: "NSE",
  source: "NSE_SHP_XBRL",
  fiiPct: 20.4,
  diiPct: 14.8,
  mutualFundPct: 9.2,
  insurancePct: 3.1,
  banksFiPct: 0.4,
  govtPct: 0,
  retailPct: 12.4,
  promoterShares: 3_200_000_000n,
  fiiShares: 1_100_000_000n,
  diiShares: 900_000_000n,
  publicShares: 1_200_000_000n,
  totalShares: 6_441_503_000n,
};

const PRIOR: OwnershipBreakdownRow = {
  quarter: "2026-03",
  exchange: "NSE",
  source: "NSE_SHP_XBRL",
  fiiPct: 20,
  diiPct: 15,
  mutualFundPct: 8.9,
  insurancePct: null,
  banksFiPct: 0,
  govtPct: 0,
  retailPct: 12.6,
};

describe("MONEY-1255 A3.3 — buildOwnershipBreakdownSection", () => {
  it("shapes the latest quarter with its QoQ movement", () => {
    const out = buildOwnershipBreakdownSection([LATEST, PRIOR]);
    assert.equal(out.quarter, "2026-06");
    assert.equal(out.label, "Jun 2026");
    assert.equal(out.prevQuarter, "2026-03");
    assert.equal(out.comparable, true);
    assert.equal(out.source, "NSE_SHP_XBRL");

    const fii = out.legs.find((l) => l.key === "fii");
    assert.equal(fii?.pct, 20.4);
    assert.equal(fii?.deltaPct, 0.4);
    const dii = out.legs.find((l) => l.key === "dii");
    assert.equal(dii?.pct, 14.8);
    assert.equal(dii?.deltaPct, -0.2);

    // All seven lines the card promises, in filing order.
    assert.deepEqual(
      out.legs.map((l) => l.key),
      ["fii", "dii", "mutualFund", "insurance", "banksFi", "govt", "retail"],
    );
    // MF / insurance / banks / government sit INSIDE the DII total; the flag is
    // what stops the card presenting eight addends that over-sum the register.
    assert.deepEqual(
      out.legs.filter((l) => l.nested).map((l) => l.key),
      ["mutualFund", "insurance", "banksFi", "govt"],
    );
  });

  it("[absence] a category nobody filed is null, and a filed zero is zero", () => {
    const out = buildOwnershipBreakdownSection([LATEST, PRIOR]);
    const govt = out.legs.find((l) => l.key === "govt");
    // Bank of Baroda's GovernmentsMember is a filed 0 (37,946 of 5.17bn shares).
    assert.equal(govt?.pct, 0);
    assert.notEqual(govt?.pct, null);

    const bare = buildOwnershipBreakdownSection([
      { quarter: "2026-06", fiiPct: 1 },
    ]);
    // BEDMUTHA files no institutional members at all. `Number("")` is 0 and
    // that coercion is how "we could not read it" becomes "they hold none".
    assert.equal(bare.legs.find((l) => l.key === "dii")?.pct, null);
    assert.notEqual(bare.legs.find((l) => l.key === "dii")?.pct, 0);
  });

  it("[regression] refuses a delta across a NON-ADJACENT quarter", () => {
    // [Jun-26, Jun-25] is one row apart and FOUR quarters apart. Subtracting
    // positionally labels a year of drift "this quarter" — the same defect
    // computeQoqDeltas documents for the summary table.
    const out = buildOwnershipBreakdownSection([
      LATEST,
      { ...PRIOR, quarter: "2025-06" },
    ]);
    assert.equal(out.comparable, false);
    assert.equal(out.legs.find((l) => l.key === "fii")?.deltaPct, null);
    assert.equal(out.institutionalDeltaPct, null);
    // …and still NAMES the neighbour, so the card can say what it declined to
    // compare against instead of looking like it found nothing.
    assert.equal(out.prevQuarter, "2025-06");
    assert.equal(out.prevLabel, "Jun 2025");
  });

  it("ranks quarters rather than trusting input order", () => {
    const out = buildOwnershipBreakdownSection([PRIOR, LATEST]);
    assert.equal(out.quarter, "2026-06");
    assert.equal(out.prevQuarter, "2026-03");
  });

  it("collapses a dual-filed quarter and honours preferExchange", () => {
    // Same `@@unique([symbol, exchange, quarter])` as the summary table, so the
    // same duplicate arrives here. Undeduped, `[0]` and `[1]` would be the same
    // period and every delta would read as a confident 0.
    const rows: OwnershipBreakdownRow[] = [
      { ...LATEST, exchange: "NSE", source: "NSE_SHP_XBRL", fiiPct: 20.4 },
      { ...LATEST, exchange: "BSE", source: "BSE_SHP", fiiPct: 19.9 },
      { ...PRIOR, exchange: "NSE" },
    ];
    const nse = buildOwnershipBreakdownSection(rows);
    assert.equal(nse.legs.find((l) => l.key === "fii")?.pct, 20.4);
    assert.equal(nse.source, "NSE_SHP_XBRL");
    assert.equal(
      nse.prevQuarter,
      "2026-03",
      "the dedupe must free a slot for the prior quarter",
    );

    const bse = buildOwnershipBreakdownSection(rows, { preferExchange: "BSE" });
    assert.equal(bse.legs.find((l) => l.key === "fii")?.pct, 19.9);
    assert.equal(bse.source, "BSE_SHP");
  });

  it("hands share counts over as STRINGS, and the payload survives the wire", () => {
    const out = buildOwnershipBreakdownSection([LATEST, PRIOR]);
    assert.equal(out.shares.total, "6441503000");
    assert.equal(typeof out.shares.total, "string");
    assert.equal(out.shares.fii, "1100000000");
    // The failure this replaces is not a wrong number — it is a 500. A BigInt
    // anywhere in the payload throws inside JSON.stringify at the
    // server/client boundary.
    assert.doesNotThrow(() => JSON.stringify(out));
    assert.equal(JSON.parse(JSON.stringify(out)).shares.total, "6441503000");
  });

  it("an all-absent row is empty, and a row with only counts is not", () => {
    const nothing = buildOwnershipBreakdownSection([{ quarter: "2026-06" }]);
    assert.equal(hasOwnershipBreakdownValues(nothing), false);

    const countsOnly = buildOwnershipBreakdownSection([
      { quarter: "2026-06", totalShares: 10n },
    ]);
    assert.equal(hasOwnershipBreakdownValues(countsOnly), true);

    assert.equal(
      hasOwnershipBreakdownValues(buildOwnershipBreakdownSection([])),
      false,
    );
  });

  it("survives a row with no quarter without inventing one", () => {
    const out = buildOwnershipBreakdownSection([{ quarter: "  ", fiiPct: 5 }]);
    assert.equal(out.quarter, null);
    assert.equal(out.label, null);
    assert.equal(out.source, null);
    assert.equal(hasOwnershipBreakdownValues(out), false);
  });
});

describe("MONEY-1255 A3.3 — breakdownRowSource", () => {
  it("codes both writers", () => {
    assert.equal(
      breakdownRowSource({ source: "NSE_SHP_XBRL" }),
      "NSE_SHP_XBRL",
    );
    assert.equal(breakdownRowSource({ source: "BSE_SHP" }), "BSE_SHP");
  });
  it("falls back to the exchange, then to the schema default", () => {
    assert.equal(breakdownRowSource({ exchange: "BSE" }), "BSE_SHP");
    assert.equal(breakdownRowSource({}), "NSE_SHP_XBRL");
  });
  it("refuses to guess for an exchange it cannot code", () => {
    assert.equal(breakdownRowSource({ exchange: "MSEI" }), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The guarded arithmetic
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 — relativeChangePct refuses, never renders Infinity", () => {
  it("[zero denominator] a move OFF zero has no percentage change", () => {
    // `(0.4 - 0) / 0` is Infinity, and "+Infinity%" on a screen is this repo's
    // most-repeated defect class. The percentage-POINT delta beside it carries
    // the fact honestly.
    assert.equal(relativeChangePct(0.4, 0), null);
    assert.notEqual(relativeChangePct(0.4, 0), Infinity);
    // 0 → 0 is 0/0 = NaN, which `?? 0` does NOT catch.
    assert.equal(relativeChangePct(0, 0), null);
  });

  it("[NaN] a non-finite input is refused on either side", () => {
    assert.equal(relativeChangePct(Number.NaN, 10), null);
    assert.equal(relativeChangePct(10, Number.NaN), null);
    assert.equal(relativeChangePct(Number.POSITIVE_INFINITY, 10), null);
    assert.equal(relativeChangePct(10, Number.POSITIVE_INFINITY), null);
  });

  it("[absence] null and undefined are not zero", () => {
    assert.equal(relativeChangePct(null, 10), null);
    assert.equal(relativeChangePct(10, null), null);
    assert.equal(relativeChangePct(undefined, undefined), null);
  });

  it("computes the ordinary case, including a fall", () => {
    assert.equal(relativeChangePct(20.4, 20), 2);
    assert.equal(relativeChangePct(14.8, 15), -1.33);
    // A holding that went to zero fell 100% — defined, because the DENOMINATOR
    // is what has to be non-zero, not the numerator.
    assert.equal(relativeChangePct(0, 5), -100);
  });

  it("is wired into every leg of the card", () => {
    const out = buildOwnershipBreakdownSection([
      { quarter: "2026-06", fiiPct: 0.4, banksFiPct: 0.4 },
      { quarter: "2026-03", fiiPct: 0.2, banksFiPct: 0 },
    ]);
    assert.equal(out.legs.find((l) => l.key === "fii")?.changePct, 100);
    // The zero-denominator leg: a real point delta, and NO relative change.
    const banks = out.legs.find((l) => l.key === "banksFi");
    assert.equal(banks?.deltaPct, 0.4);
    assert.equal(banks?.changePct, null);
  });
});

describe("MONEY-1255 — institutionalTotal derives from GUARDED values", () => {
  it("sums FII + DII when the filing reported both", () => {
    assert.equal(
      institutionalTotal({ quarter: "q", fiiPct: 20.4, diiPct: 14.8 }),
      35.2,
    );
  });

  it("refuses rather than summing around a missing leg", () => {
    // A total short by exactly DII, rendered as a confident number with nothing
    // on screen to say so, is worse than no total.
    assert.equal(
      institutionalTotal({ quarter: "q", fiiPct: 20.4, diiPct: null }),
      null,
    );
    assert.equal(
      institutionalTotal({ quarter: "q", fiiPct: null, diiPct: 14.8 }),
      null,
    );
    assert.equal(institutionalTotal(null), null);
  });

  it("[NaN] does not let a poisoned leg through — `?? 0` would", () => {
    assert.equal(
      institutionalTotal({ quarter: "q", fiiPct: Number.NaN, diiPct: 14.8 }),
      null,
    );
  });

  it("two reported zeros are a real total of zero", () => {
    assert.equal(institutionalTotal({ quarter: "q", fiiPct: 0, diiPct: 0 }), 0);
  });

  it("reaches the section, with its own guarded delta", () => {
    const out = buildOwnershipBreakdownSection([LATEST, PRIOR]);
    assert.equal(out.institutionalPct, 35.2);
    assert.equal(out.institutionalDeltaPct, 0.2);

    // A prior quarter missing a leg cannot produce a delta either.
    const halfPrior = buildOwnershipBreakdownSection([
      LATEST,
      { ...PRIOR, diiPct: null },
    ]);
    assert.equal(halfPrior.institutionalPct, 35.2);
    assert.equal(halfPrior.institutionalDeltaPct, null);
  });
});

describe("MONEY-1255 — shareCountString", () => {
  it("renders every digit of a BigInt", () => {
    assert.equal(shareCountString(6_441_503_000n), "6441503000");
    // Beyond 2^53 — the case Number() would silently round and String() would
    // print as "1e+21".
    assert.equal(
      shareCountString(9007199254740993n),
      "9007199254740993",
      "a share count must not be routed through a double",
    );
    assert.equal(shareCountString(0n), "0", "a filed zero is a fact");
  });

  it("accepts a plain number without exponential notation", () => {
    assert.equal(shareCountString(1000), "1000");
    assert.equal(shareCountString(1e21), "1000000000000000000000");
  });

  it("[absence] refuses blanks, sentinels and junk rather than returning 0", () => {
    for (const v of [
      null,
      undefined,
      "",
      "  ",
      "-",
      "NA",
      "N/A",
      "12a",
      {},
      [],
    ]) {
      assert.equal(
        shareCountString(v),
        null,
        `${JSON.stringify(v)} became a count`,
      );
    }
  });

  it("[non-finite] NaN and Infinity are not counts", () => {
    assert.equal(shareCountString(Number.NaN), null);
    assert.equal(shareCountString(Number.POSITIVE_INFINITY), null);
  });

  it("passes a decimal string through verbatim", () => {
    assert.equal(shareCountString("6441503000"), "6441503000");
    assert.equal(shareCountString(" 42 "), "42");
  });
});
