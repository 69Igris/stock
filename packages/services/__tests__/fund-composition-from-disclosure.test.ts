/**
 * MONEY-1405 D4/D5 — the composition built from the AMC's own disclosure.
 *
 * NO SHADOW: every assertion runs the REAL exported functions from
 * `packages/services/src/fund-composition-from-disclosure.ts` (the module the
 * service calls) and, for the index heuristic, the REAL `resolveIndexRoute` /
 * `normalizeIndexSlug` from `packages/core` — both pure, both imported by
 * relative path, no I/O at import.
 *
 * What is pinned here, and why each one is a defect and not a preference:
 *
 *  - a line that did not resolve is COUNTED, under "Unclassified". Every weight
 *    is a share of NAV, so the donut's denominator is the whole portfolio;
 *    dropping the unattributable rows (TREPS, net receivables, an ISIN our
 *    master has never seen) silently renormalises every remaining slice upward.
 *  - the SECTOR and CAP donuts fill the circle (`normalizeWeightsTo100`), the
 *    ASSET one does NOT. A portfolio that discloses 99.7% must read 99.7%
 *    somewhere, and the asset split is where cash is visible AS cash.
 *  - the AMC's holdingType vocabulary is mapped, not passed through: it carries
 *    `DERIVATIVE` and `REIT_INVIT`, which the composition vocabulary has never
 *    had, and an unmapped value would put a one-off legend key on the chart.
 *  - `confidence` is 0 and `source` is `AMC_DISCLOSURE`. A filing has no
 *    self-grade; inventing a 1.0 would be the same manufactured trust the
 *    Gemini path was carrying at 0.95-0.99 over 26-month-old content.
 *
 * MEASURED (prod, 2026-09-13) — the shape these cases model is the real one:
 * HDFC NIFTY 50 ETF, scheme 135853, period 2026-07 → 52 rows summing to
 * EXACTLY 100.000%: 50 EQUITY lines (all 50 ISINs resolving to an NSE row with
 * a real sector, all 50 symbols hitting a cap index) plus "TREPS - Tri-party
 * Repo" and "Net Current Assets", both CASH and both with NO ISIN.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCompositionFromDisclosure,
  capBucketsBySymbol,
  crossCheckIndexSubset,
  disclosureMonth,
  indexIdForFundName,
  resolveInstrumentsByIsin,
  CAP_INDEX_PRIORITY,
  UNCLASSIFIED,
  type CapBucket,
  type DisclosureRow,
  type InstrumentFacts,
  type InstrumentRow,
} from "../src/fund-composition-from-disclosure";
import {
  normalizeIndexSlug,
  resolveIndexRoute,
} from "../../core/src/market-data/discover-section-logic";

// ── fixtures ────────────────────────────────────────────────────────────────

function row(overrides: Partial<DisclosureRow> = {}): DisclosureRow {
  return {
    instrumentName: "HDFC Bank Ltd",
    isin: "INE040A01034",
    holdingType: "EQUITY",
    percentToNav: 10,
    ...overrides,
  };
}

const PERIOD = new Date(Date.UTC(2026, 6, 1));

/**
 * The measured HDFC NIFTY 50 ETF shape, shrunk to 3 equities + 2 cash lines.
 *
 * The equity lines are NOT in weight order, deliberately. An AMC workbook is
 * printed by SEBI section and then in the house's own order — alphabetical
 * here — and it is the composition that owes the reader heaviest-first. A
 * fixture that arrives already descending makes the "heaviest first" case
 * vacuous: deleting the `.sort()` in `buildCompositionFromDisclosure` left it
 * green, because sorting a sorted list is a no-op.
 */
function niftyEtfRows(): DisclosureRow[] {
  return [
    row({
      instrumentName: "HDFC Bank Ltd",
      isin: "INE040A01034",
      percentToNav: 40,
    }),
    row({
      instrumentName: "Infosys Ltd",
      isin: "INE009A01021",
      percentToNav: 24.7,
    }),
    row({
      instrumentName: "Reliance Industries Ltd",
      isin: "INE002A01018",
      percentToNav: 35,
    }),
    row({
      instrumentName: "TREPS - Tri-party Repo",
      isin: null,
      holdingType: "CASH",
      percentToNav: 0.2,
    }),
    row({
      instrumentName: "Net Current Assets",
      isin: null,
      holdingType: "CASH",
      percentToNav: 0.1,
    }),
  ];
}

function instruments(): Map<string, InstrumentFacts> {
  return new Map<string, InstrumentFacts>([
    [
      "INE040A01034",
      { symbol: "HDFCBANK", sector: "Financial Services", industry: "Banking" },
    ],
    [
      "INE002A01018",
      { symbol: "RELIANCE", sector: "Energy", industry: "Refineries" },
    ],
    [
      "INE009A01021",
      {
        symbol: "INFY",
        sector: "Information Technology",
        industry: "IT Services",
      },
    ],
  ]);
}

function caps(): Map<string, CapBucket> {
  return new Map<string, CapBucket>([
    ["INE040A01034", "LARGE"],
    ["INE002A01018", "LARGE"],
    ["INE009A01021", "LARGE"],
  ]);
}

function build(
  rows: DisclosureRow[] = niftyEtfRows(),
  inst: Map<string, InstrumentFacts> = instruments(),
  cap: Map<string, CapBucket> = caps(),
) {
  return buildCompositionFromDisclosure(
    { fundType: "ETF", fundId: "HDFCNIFETF", period: PERIOD, holdings: rows },
    inst,
    cap,
  );
}

const sum = (xs: ReadonlyArray<{ weight: number }>): number =>
  xs.reduce((s, x) => s + x.weight, 0);

// ══════════════════════════════════════════════════════════════════════════
// The donuts
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1405 D4 — sector donut from the disclosure", () => {
  it("sums to 100 ± 0.1 AND names the real sectors, with ONE Unclassified slice", () => {
    const out = build();
    assert.ok(
      Math.abs(sum(out.sectorBreakdown) - 100) <= 0.1,
      `a donut is a whole; got ${sum(out.sectorBreakdown)}`,
    );
    // MUTATION: call `build(niftyEtfRows(), new Map())` — i.e. drop the ISIN
    // join. The sum above STILL reads 100 (one slice at 100%), and only this
    // assertion goes red. Both halves are required; VERIFIED red.
    assert.deepStrictEqual(
      out.sectorBreakdown.map((s) => s.sector).sort(),
      [
        "Energy",
        "Financial Services",
        "Information Technology",
        UNCLASSIFIED,
      ].sort(),
    );
    const unclassified = out.sectorBreakdown.filter(
      (s) => s.sector === UNCLASSIFIED,
    );
    assert.strictEqual(unclassified.length, 1);
    // 0.3 of 99.999 disclosed, rescaled — counted, not dropped.
    assert.ok(unclassified[0]!.weight > 0, "the cash lines keep their weight");
  });

  it("[regression] with NO ISIN join at all the weight still sums to 100 — it does not vanish", () => {
    // The failure this forbids: unattributable rows dropped, so the chart
    // looks tidy and every remaining slice is silently inflated.
    const out = build(niftyEtfRows(), new Map(), new Map());
    assert.deepStrictEqual(
      out.sectorBreakdown.map((s) => s.sector),
      [UNCLASSIFIED],
    );
    assert.ok(Math.abs(sum(out.sectorBreakdown) - 100) <= 0.1);
    assert.strictEqual(out.totalHoldings, 5, "no row was dropped");
  });

  it('a resolved instrument with a literal "N/A" sector is an ABSTENTION, not a sector', () => {
    // 10,893 active NSE equity rows on prod carry sector "N/A". Rendering that
    // as a slice puts a legend entry on the chart that means "we do not know".
    const inst = new Map<string, InstrumentFacts>([
      ["INE040A01034", { symbol: "HDFCBANK", sector: "N/A", industry: null }],
    ]);
    const out = build([row({ percentToNav: 100 })], inst, new Map());
    assert.deepStrictEqual(
      out.sectorBreakdown.map((s) => s.sector),
      [UNCLASSIFIED],
    );
  });
});

describe("MONEY-1405 D4 — cap donut from index membership", () => {
  it("buckets by membership and fills the circle", () => {
    const out = build();
    const byCap = new Map(out.capBreakdown.map((c) => [c.cap, c.weight]));
    assert.ok((byCap.get("LARGE") ?? 0) > 99, "three large caps + 0.3% cash");
    assert.ok(byCap.has(UNCLASSIFIED), "the cash lines are counted");
    assert.ok(Math.abs(sum(out.capBreakdown) - 100) <= 0.1);
  });

  it("capBucketsBySymbol resolves an overlapping symbol by PRIORITY, not by row order", () => {
    // A symbol legitimately appears in more than one list. Last-write-wins
    // would make the bucket depend on the order `findMany` returned rows in.
    const map = capBucketsBySymbol([
      { indexId: "niftysmallcap250", symbol: "DUALLISTED" },
      { indexId: "nifty50", symbol: "DUALLISTED" },
      { indexId: "niftymidcap150", symbol: "MIDCO" },
      { indexId: "niftynext50", symbol: "NEXTCO" },
    ]);
    // MUTATION: reverse CAP_INDEX_PRIORITY → DUALLISTED becomes SMALL. VERIFIED.
    assert.strictEqual(map.get("DUALLISTED"), "LARGE");
    assert.strictEqual(map.get("MIDCO"), "MID");
    assert.strictEqual(map.get("NEXTCO"), "LARGE");
  });

  it("ignores an index it was not asked about (a stray indexId is not a bucket)", () => {
    const map = capBucketsBySymbol([
      { indexId: "niftymicrocap250", symbol: "MICROCO" },
      { indexId: "banknifty", symbol: "HDFCBANK" },
    ]);
    assert.strictEqual(map.size, 0);
  });

  it("the four cap indices are the ones that exist on prod", () => {
    // Measured 2026-09-13 against `index_constituents`: nifty50 50,
    // niftynext50 50, niftymidcap150 150, niftysmallcap250 250. This table's
    // vocabulary is NOT `IndexClose.indexSlug`'s ("banknifty" vs "nifty-bank"),
    // so a plausible-looking id resolves to an empty list and silently buckets
    // the whole fund Unclassified.
    assert.deepStrictEqual(
      CAP_INDEX_PRIORITY.map(([id]) => id),
      ["nifty50", "niftynext50", "niftymidcap150", "niftysmallcap250"],
    );
  });
});

describe("MONEY-1405 D4 — the asset donut keeps cash visible AS cash", () => {
  it("is NOT rescaled: a portfolio disclosing 99.7% reads 99.7%", () => {
    const out = build([
      row({ percentToNav: 60 }),
      row({
        instrumentName: "TREPS",
        isin: null,
        holdingType: "CASH",
        percentToNav: 39.7,
      }),
    ]);
    // MUTATION: wrap assetBreakdown in normalizeWeightsTo100 → 60.18 / 39.82
    // and the undisclosed 0.3% disappears. VERIFIED red.
    assert.deepStrictEqual(
      out.assetBreakdown.map((a) => [a.type, a.weight]),
      [
        ["EQUITY", 60],
        ["CASH", 39.7],
      ],
    );
    assert.strictEqual(out.coveragePercent, 99.7);
  });

  it("maps the AMC vocabulary onto the composition one (DERIVATIVE/REIT_INVIT)", () => {
    const out = build([
      row({ holdingType: "REIT_INVIT", percentToNav: 50 }),
      row({
        instrumentName: "NIFTY FUT",
        holdingType: "DERIVATIVE",
        isin: null,
        percentToNav: 30,
      }),
      row({
        instrumentName: "Mystery",
        holdingType: "SOMETHING_NEW",
        isin: null,
        percentToNav: 20,
      }),
    ]);
    // MUTATION: pass `row.holdingType` straight through → "REIT_INVIT" /
    // "DERIVATIVE" / "SOMETHING_NEW" land on the legend. VERIFIED red.
    assert.deepStrictEqual(out.assetBreakdown.map((a) => a.type).sort(), [
      "OTHER",
      "REIT",
    ]);
  });
});

describe("MONEY-1405 D4 — provenance and the undisclosed weight", () => {
  it("stamps AMC_DISCLOSURE, a real period, and NO self-graded confidence", () => {
    const out = build();
    assert.strictEqual(out.source, "AMC_DISCLOSURE");
    assert.strictEqual(out.dataAsOf, "2026-07");
    // MUTATION: set `confidence: 1` → red. A filing has no self-grade, and the
    // 0.95-0.99 the Gemini path carried is exactly what D6 removed.
    assert.strictEqual(out.confidence, 0);
  });

  it("a null percentToNav is 0 weight and a KEPT row — 'not disclosed' is not 'absent'", () => {
    const out = build([
      row({ percentToNav: 99 }),
      row({ instrumentName: "Unpriced Line", isin: null, percentToNav: null }),
    ]);
    assert.strictEqual(out.totalHoldings, 2);
    assert.strictEqual(out.holdings[1]!.weightPercent, 0);
    assert.strictEqual(out.coveragePercent, 99);
    for (const h of out.holdings) assert.ok(Number.isFinite(h.weightPercent));
  });

  it("holdings come back heaviest first, from a sheet that is not in weight order", () => {
    // The fixture arrives 40 / 24.7 / 35 / 0.2 / 0.1 — alphabetical, the way an
    // AMC prints it. MUTATION: drop the `.sort()` in
    // `buildCompositionFromDisclosure` → RED on both assertions below. It used
    // to be GREEN, because the fixture was already descending.
    const out = build();
    const weights = out.holdings.map((h) => h.weightPercent);
    assert.deepStrictEqual(weights, [40, 35, 24.7, 0.2, 0.1]);
    assert.deepStrictEqual(
      out.holdings.map((h) => h.holdingName),
      [
        "HDFC Bank Ltd",
        "Reliance Industries Ltd",
        "Infosys Ltd",
        "TREPS - Tri-party Repo",
        "Net Current Assets",
      ],
    );
  });

  it("disclosureMonth refuses an Invalid Date rather than rendering one", () => {
    assert.strictEqual(disclosureMonth(new Date("garbage")), "");
    assert.strictEqual(disclosureMonth(null), "");
    assert.strictEqual(
      disclosureMonth(new Date(Date.UTC(2026, 0, 1))),
      "2026-01",
    );
  });

  it("an empty disclosure is empty-but-finite, never NaN", () => {
    const out = build([], new Map(), new Map());
    assert.deepStrictEqual(out.holdings, []);
    assert.deepStrictEqual(out.sectorBreakdown, []);
    assert.strictEqual(out.coveragePercent, 0);
    assert.strictEqual(out.totalHoldings, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D5 — the index subset cross-check
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1405 D5 — fund name → index, via the REAL route resolver", () => {
  const resolve = (name: string) =>
    indexIdForFundName(name, resolveIndexRoute, normalizeIndexSlug);

  it("resolves the index an ETF is named after, from the AMC's verbatim scheme name", () => {
    assert.strictEqual(
      resolve(
        "HDFC NIFTY 50 ETF (An open ended scheme replicating / tracking NIFTY 50 Index)",
      ),
      "nifty50",
    );
    assert.strictEqual(
      resolve(
        "HDFC NIFTY NEXT 50 ETF (An open ended scheme replicating/tracking NIFTY Next 50 Index TRI)",
      ),
      "niftynext50",
      "the 3-token window must be tried before the 2-token one",
    );
    assert.strictEqual(
      resolve(
        "HDFC NIFTY 100 ETF (An open ended scheme replicating/tracking NIFTY 100 Index TRI)",
      ),
      "nifty100",
    );
  });

  it("[regression] NIFTY 500 is not NIFTY 50", () => {
    // MUTATION: match slugs as SUBSTRINGS of the normalised name instead of as
    // token windows → "nifty-500-..." contains "nifty-50" and this returns
    // nifty50, cross-checking a 500-name fund against 50 constituents.
    // VERIFIED red.
    assert.strictEqual(
      resolve("Motilal Oswal Nifty 500 Index Fund"),
      "nifty500",
    );
  });

  it("returns null rather than guessing for an index we hold no constituents for", () => {
    for (const name of [
      "HDFC BSE 500 ETF (An open ended scheme tracking S&P BSE 500 Index TRI)",
      "HDFC Nifty Metal ETF (An open ended scheme replicating/tracking Nifty Metal Index (TRI))",
      "HDFC NIFTY PSU BANK ETF",
      "HDFC NIFTY200 MOMENTUM 30 ETF",
      "HDFC Gold ETF",
      "Parag Parikh Flexi Cap Fund",
    ]) {
      assert.strictEqual(resolve(name), null, name);
    }
  });

  it("[regression] a bare 'Nifty' token never resolves — the window floor is 2", () => {
    // `INDEX_SLUG_ALIASES` maps the single token "nifty" to "nifty-50". A
    // 1-token window would therefore make EVERY fund with "Nifty" in its name
    // cross-check against the NIFTY 50, including Nifty Metal above.
    assert.strictEqual(resolve("Nifty"), null);
    assert.strictEqual(resolve("SBI Nifty Bank ETF"), "banknifty");
  });
});

describe("MONEY-1405 D5 — crossCheckIndexSubset is a diagnostic, never a gate", () => {
  it("reports the constituents a disclosure does not list", () => {
    const check = crossCheckIndexSubset(
      "nifty50",
      ["HDFCBANK", "RELIANCE", "INFY"],
      ["HDFCBANK", "INFY", null],
    );
    assert.ok(check);
    assert.strictEqual(check!.indexId, "nifty50");
    assert.strictEqual(check!.constituents, 3);
    assert.deepStrictEqual(check!.missing, ["RELIANCE"]);
  });

  it("a clean subset reports zero misses, in BOTH casings", () => {
    // Both sides, because the guard is two `.toUpperCase()` calls and a test
    // that only lower-cases ONE side passes with the other one deleted. This
    // case was VACUOUS in exactly that way before it was re-measured.
    const lowerHolding = crossCheckIndexSubset(
      "nifty50",
      ["HDFCBANK"],
      ["hdfcbank", "EXTRA"],
    );
    const lowerConstituent = crossCheckIndexSubset(
      "nifty50",
      ["hdfcbank"],
      ["HDFCBANK", "EXTRA"],
    );
    // MUTATION: drop EITHER `.toUpperCase()` → one of these reports a clean
    // subset as a defect. VERIFIED red on both.
    assert.deepStrictEqual(lowerHolding!.missing, [], "holding lower-cased");
    assert.deepStrictEqual(
      lowerConstituent!.missing,
      [],
      "constituent lower-cased",
    );
  });

  it("no index / no constituents → null, and an ETF holding MORE than the index is not a miss", () => {
    assert.strictEqual(crossCheckIndexSubset(null, ["X"], ["X"]), null);
    assert.strictEqual(crossCheckIndexSubset("nifty50", [], ["X"]), null);
    const extra = crossCheckIndexSubset("nifty50", ["A"], ["A", "B", "C"]);
    assert.deepStrictEqual(extra!.missing, []);
  });
});

describe("MONEY-1401 F20 — a donut of nothing does not claim a SEBI filing", () => {
  /**
   * `percentToNav` is nullable and null means "not disclosed", which becomes a
   * 0 weight so the LINE still renders. `normalizeWeightsTo100` then correctly
   * refuses to divide by zero and hands back the zeros, and the UI guards on
   * `sectorBreakdown.length > 0` — so rows present with every weight null gave
   * a "Sector Allocation" card, an empty circle, a `0.0%` legend, and a footer
   * asserting the fund house filed it.
   *
   * MEASURED (prod 2026-09-13): 336 of 54,248 rows carry a null `percentToNav`
   * and ZERO of the 662 scheme-months are entirely null, so nothing renders
   * this way today. The shape is live all the same — the AMFI NAVAll parser
   * nulled a whole column for 26 days one table over (MONEY-1403) — and what
   * it costs is a false provenance claim rather than a missing chart.
   */
  const allNull: DisclosureRow[] = [
    row({
      instrumentName: "HDFC Bank Ltd",
      isin: "INE040A01034",
      percentToNav: null,
    }),
    row({
      instrumentName: "Reliance Industries Ltd",
      isin: "INE002A01018",
      percentToNav: null,
    }),
    row({
      instrumentName: "TREPS",
      isin: null,
      holdingType: "CASH",
      percentToNav: null,
    }),
  ];
  const facts = new Map<string, InstrumentFacts>([
    [
      "INE040A01034",
      { symbol: "HDFCBANK", sector: "Financial Services", industry: null },
    ],
    ["INE002A01018", { symbol: "RELIANCE", sector: "Energy", industry: null }],
  ]);

  it("every weight null → NO sector, cap or asset breakdown at all", () => {
    // MUTATION: `droppingAllZero` → `return slices;` →
    //   AssertionError: 2 !== 0 (two zero-weight sector slices ship). VERIFIED.
    const out = buildCompositionFromDisclosure(
      { fundType: "MF", fundId: "119598", period: PERIOD, holdings: allNull },
      facts,
      new Map([["INE040A01034", "LARGE" as CapBucket]]),
    );
    assert.deepStrictEqual(out.sectorBreakdown, []);
    assert.deepStrictEqual(out.capBreakdown, []);
    assert.deepStrictEqual(out.assetBreakdown, []);
  });

  it("the HOLDINGS survive — the AMC disclosed the names, just not the weights", () => {
    // The opposite failure, and the reason this is a breakdown guard and not a
    // whole-composition one: dropping the rows too would turn "we have the
    // portfolio but no weights" into "this fund filed nothing", and fall
    // through to a model recollection.
    // MUTATION: return `null` / empty holdings for an all-zero portfolio →
    //   AssertionError: 0 !== 3. VERIFIED red.
    const out = buildCompositionFromDisclosure(
      { fundType: "MF", fundId: "119598", period: PERIOD, holdings: allNull },
      facts,
      new Map(),
    );
    assert.strictEqual(out.totalHoldings, 3);
    assert.strictEqual(out.source, "AMC_DISCLOSURE");
    assert.strictEqual(out.dataAsOf, "2026-07");
  });

  it("ONE non-zero weight is enough to keep the donut", () => {
    // The boundary. A guard written as `every(w === 0)` and one written as
    // `!some(w > 0)` agree here; one written as `total < 1` would not, and
    // would delete a real 0.4% cash-only sleeve.
    // MUTATION: `some((s) => s.weight > 0)` → `s.weight > 1` →
    //   AssertionError: [] is not the expected single slice. VERIFIED red.
    const out = buildCompositionFromDisclosure(
      {
        fundType: "MF",
        fundId: "119598",
        period: PERIOD,
        holdings: [
          row({ isin: "INE040A01034", percentToNav: 0.4 }),
          row({
            instrumentName: "TREPS",
            isin: null,
            holdingType: "CASH",
            percentToNav: null,
          }),
        ],
      },
      facts,
      new Map(),
    );
    assert.strictEqual(out.sectorBreakdown.length, 2);
    // The SECTOR donut is rescaled to 100 by `normalizeWeightsTo100`, so a 0.4%
    // slice reads 100 there and cannot distinguish `> 0` from `> 1`. The ASSET
    // breakdown is deliberately NOT rescaled — it is the one place a real 0.4%
    // sleeve survives as 0.4% — so it is the only one that can pin the
    // boundary. Asserting on the sector slice alone left this case GREEN under
    // the `> 1` mutation; measured, not assumed.
    const equity = out.assetBreakdown.find((sl) => sl.type === "EQUITY");
    assert.strictEqual(equity?.weight, 0.4);
  });
});

describe("MONEY-1401 F21 — the ISIN join picks ONE row by rank, not by arrival order", () => {
  /**
   * The reviewer named the 870 documented NSE suffixed twins (`SYM-BE`/`-SM`)
   * as the population. They cannot reach this function: a suffixed twin is the
   * row with NO ISIN, and the caller's query is `isin: { in: [...] }`.
   *
   * MEASURED (prod 2026-09-13) the real collision is a RENAME — exactly 2
   * ISINs platform-wide carry more than one NSE row, and both appear verbatim
   * below. 0 of the 505 ISINs held by the 11 currently-joinable schemes are
   * among them, so this is determinism ahead of the data.
   */
  const KDGREEN: InstrumentRow = {
    isin: "INE348N01042",
    symbol: "KDGREEN",
    exchange: "NSE",
    sector: "Utilities",
    industry: null,
    isActive: true,
  };
  const MANBRO: InstrumentRow = {
    isin: "INE348N01042",
    symbol: "MANBRO",
    exchange: "NSE",
    sector: "Utilities",
    industry: null,
    isActive: false,
  };
  const NSE_HDFC: InstrumentRow = {
    isin: "INE040A01034",
    symbol: "HDFCBANK",
    exchange: "NSE",
    sector: "Financial Services",
    industry: null,
    isActive: true,
  };
  const BSE_HDFC: InstrumentRow = {
    isin: "INE040A01034",
    symbol: "500180",
    exchange: "BSE",
    sector: null,
    industry: null,
    isActive: true,
  };

  it("ACTIVE beats renamed-away, in BOTH arrival orders", () => {
    // BOTH orders, because last-write-wins already produces the right answer
    // for one of them — a single-order case is vacuous by construction, which
    // is how the NSE-vs-BSE case in this suite was written the first time.
    // MUTATION: `best.set(isin, row)` unconditionally →
    //   AssertionError on "stale last": 'MANBRO' !== 'KDGREEN'. VERIFIED.
    for (const [label, rows] of [
      ["stale first", [MANBRO, KDGREEN]],
      ["stale last", [KDGREEN, MANBRO]],
    ] as const) {
      const out = resolveInstrumentsByIsin(rows);
      assert.strictEqual(out.get("INE348N01042")!.symbol, "KDGREEN", label);
    }
  });

  it("NSE beats BSE even when the BSE row is the active one, in BOTH orders", () => {
    // Exchange outranks activity: `index_constituents.symbol` is the NSE
    // primary symbol, so a BSE scrip id costs every cap bucket.
    // MUTATION: swap the exchange and active terms in `instrumentRank` → this
    //   still passes (both are active), which is why the case below exists.
    for (const rows of [
      [BSE_HDFC, NSE_HDFC],
      [NSE_HDFC, BSE_HDFC],
    ]) {
      assert.strictEqual(
        resolveInstrumentsByIsin(rows).get("INE040A01034")!.symbol,
        "HDFCBANK",
      );
    }
  });

  it("an INACTIVE NSE row still beats an ACTIVE BSE row — exchange outranks activity", () => {
    // MUTATION: reorder `instrumentRank` to put `active` first →
    //   AssertionError: '500180' !== 'HDFCBANK'. VERIFIED red. This is the case
    //   the one above cannot make, and it is the one that pins the ORDER of the
    //   two keys rather than merely that both exist.
    const staleNse: InstrumentRow = { ...NSE_HDFC, isActive: false };
    for (const rows of [
      [BSE_HDFC, staleNse],
      [staleNse, BSE_HDFC],
    ]) {
      assert.strictEqual(
        resolveInstrumentsByIsin(rows).get("INE040A01034")!.symbol,
        "HDFCBANK",
      );
    }
  });

  it("two equally-ranked rows resolve to the SAME symbol whichever order they arrive in", () => {
    // The measured SILLYMONKS/CRESTO pair: same exchange, both active. There is
    // no evidence to prefer either, so the only property worth having is that
    // two identical reads agree — which last-write-wins does not provide.
    // MUTATION: `best.set(isin, row)` unconditionally → the two orders return
    //   different symbols. VERIFIED red.
    const a: InstrumentRow = {
      isin: "INE203Y01012",
      symbol: "SILLYMONKS",
      exchange: "NSE",
      sector: "Media",
      industry: null,
      isActive: true,
    };
    const b: InstrumentRow = { ...a, symbol: "CRESTO" };
    assert.strictEqual(
      resolveInstrumentsByIsin([a, b]).get("INE203Y01012")!.symbol,
      resolveInstrumentsByIsin([b, a]).get("INE203Y01012")!.symbol,
    );
  });

  it("ACTIVE wins even when the STALE symbol sorts first alphabetically", () => {
    // The measured pair cannot make this case: MANBRO is inactive and KDGREEN
    // is active, and "KDGREEN" < "MANBRO", so the symbol TIE-BREAK alone
    // already returns the right row. Dropping the `isActive` term entirely left
    // every case above GREEN — which is the whole reason this one is synthetic
    // and says so.
    //
    // MUTATION: `void active;` — remove the activity term from
    //   `instrumentRank` → AssertionError: 'AAOLDNAME' !== 'ZZNEWNAME'.
    //   VERIFIED red. (That term matters because a renamed-away symbol is not
    //   in `index_constituents` either, so picking it costs the cap bucket.)
    const stale: InstrumentRow = {
      isin: "INE000X01011",
      symbol: "AAOLDNAME",
      exchange: "NSE",
      sector: "Industrials",
      industry: null,
      isActive: false,
    };
    const live: InstrumentRow = {
      ...stale,
      symbol: "ZZNEWNAME",
      isActive: true,
    };
    for (const rows of [
      [stale, live],
      [live, stale],
    ]) {
      assert.strictEqual(
        resolveInstrumentsByIsin(rows).get("INE000X01011")!.symbol,
        "ZZNEWNAME",
      );
    }
  });

  it("a null/blank ISIN never enters the map", () => {
    const out = resolveInstrumentsByIsin([
      { ...NSE_HDFC, isin: null },
      { ...NSE_HDFC, isin: "   " },
      NSE_HDFC,
    ]);
    assert.strictEqual(out.size, 1);
    assert.ok(out.has("INE040A01034"));
  });
});
