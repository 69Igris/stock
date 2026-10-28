/**
 * Cash-instrument classification (MONEY-1093).
 *
 * Prod held 22,090 active EQUITY rows of which 11,795 were actually debt
 * (8.85% Piramal bonds, IRFC bonds, NHAI bonds, G-Secs), and ~2,200 of those
 * carried a real sector — "0795GOI32", a GOI bond, labelled "Financial
 * Services". The instrument master comes from the Zerodha dump, which types
 * every cash instrument `EQ`.
 *
 * The cases below are grouped around the thing that actually matters here:
 * a symbol-pattern matcher CANNOT do this job. Measured against prod, the
 * candidate regex `^\d+[A-Z]+\d{2}[A-Z]?$` hit 2,236 wrong rows and recalled
 * only 2,752 of 11,795. So the "regex traps" describe below are not
 * hypothetical — they are the exact symbols that made the heuristic wrong,
 * verified present in the live 2026-07-29 BSE bhavcopy.
 *
 * Source: packages/core/src/market-data/instruments/instrument-classification.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NSE_SERIES_CLASS,
  classifyCashInstrument,
  isNonEquityClass,
  BSE_DEBT_GROUPS,
  BSE_EQUITY_GROUPS,
} from "../../src/market-data/instruments/instrument-classification";
import {
  NSE_CASH_SERIES,
  NSE_SERIES_INTENTIONALLY_UNPRICED,
  NSE_SERIES_FAMILIES_UNPRICED,
} from "../../src/market-data/bhavcopy";

/** Terse helper — most cases only vary symbol/series. */
function classify(
  symbol: string,
  exchange: string,
  series: string | null,
  name = symbol,
  extra: { isin?: string | null; segmentCode?: string | null } = {},
) {
  // `isin` and `segmentCode` are REQUIRED on `ClassifyInput` and default to
  // `null` here — "looked, not present". They were optional, and an omitted
  // `segmentCode` does not abstain: it returns EQUITY for an index row.
  return classifyCashInstrument({
    symbol,
    name,
    exchange,
    series,
    isin: extra.isin ?? null,
    segmentCode: extra.segmentCode ?? null,
  });
}

describe("BSE — the group letter decides", () => {
  it("types groups F and G as debt", () => {
    // Measured on the live file: F = 369 corporate-debt rows, G = 43 G-Secs.
    assert.equal(classify("07AGG", "BSE", "F").klass, "DEBT");
    assert.equal(classify("0795GOI32", "BSE", "G").klass, "DEBT");
  });

  it("types every equity group in the measured file as equity", () => {
    // All 12 observed on the live 2026-07-29 file. Previously this loop skipped
    // E and IF, so two entries of a safety-relevant allow-list were unexercised.
    for (const g of [
      "A",
      "B",
      "X",
      "XT",
      "T",
      "M",
      "MT",
      "MS",
      "Z",
      "E",
      "IF",
      "P",
    ]) {
      assert.equal(
        classify("SOMECO", "BSE", g).klass,
        "EQUITY",
        `group ${g} should be equity`,
      );
    }
  });

  it("reports the group in the reason so a decision is auditable", () => {
    assert.equal(classify("07AGG", "BSE", "F").reason, "bse-group-F");
    assert.equal(classify("RELIANCE", "BSE", "A").reason, "bse-group-A");
  });

  it("ABSTAINS on an unrecognised group rather than assuming equity", () => {
    // This cost a bug. The first version used only the debt deny-list and
    // treated everything else as equity — but `series` defaults to the stamped
    // string "EQ", which BSE never issues as a group, so 12,661 BSE rows whose
    // group was simply unknown were confidently classified EQUITY.
    const r = classify("NEWCO", "BSE", "Q");
    assert.equal(r.klass, "UNKNOWN");
    assert.match(r.reason, /unrecognised/);
  });

  it('never treats the stamped default "EQ" on BSE as EQUITY', () => {
    // The regression that motivated the allow-list. "EQ" is an NSE series;
    // on a BSE row it means "never sourced from the exchange".
    //
    // MONEY-1298 SPLIT the answer rather than weakening it, so this case now
    // states both halves. The invariant that mattered — never EQUITY on the
    // strength of the stamp — is unchanged and is asserted for BOTH shapes. The
    // ABSTENTION was never the invariant; it was the best answer available
    // while `name` and `isin` went unread. A row whose Kite `name` is a real
    // company name still abstains; one whose `name` is the instrument code
    // repeated is a bond code and is now decided. See the MONEY-1298 rule-table
    // suite for the measured populations behind each branch.
    const named = classifyCashInstrument({
      symbol: "SOMECO",
      name: "SOMECO INDUSTRIES LIMITED",
      exchange: "BSE",
      series: "EQ",
      isin: null,
      segmentCode: null,
    });
    assert.equal(
      named.klass,
      "UNKNOWN",
      "a BSE row with a real company name must still abstain",
    );

    // A REAL bond code, not a company-shaped placeholder. This read
    // `classify("SOMECO", ...)` with the helper's `name = symbol` default —
    // which is the third place in this branch where a fixture convenience
    // supplied the very signal the rule keys on, and here it also made the
    // case unable to tell a bond from a company: "SOMECO" is exactly the shape
    // the rule must SPARE.
    const code = classify("1020NFL27", "BSE", "EQ"); // helper sets name = symbol
    assert.notEqual(
      code.klass,
      "EQUITY",
      'a BSE row carrying only the "EQ" stamp must never be classified EQUITY',
    );
    assert.equal(code.klass, "DEBT");
    assert.equal(code.reason, "bse-unenriched-code");

    // The other side of the same fixture. `name === symbol` is fabricated by
    // `mapCSVRowToRaw`'s `row.name || baseSymbol` whenever Kite ships no name,
    // so a company-shaped symbol reaching this rule must abstain rather than
    // be retyped irreversibly.
    const companyShaped = classify("SOMECO", "BSE", "EQ");
    assert.notEqual(
      companyShaped.klass,
      "DEBT",
      "an alphabetic, company-shaped symbol must not be typed DEBT on a " +
        "name===symbol signal the parser may have fabricated",
    );
  });
});

describe("NSE — the two-character series decides", () => {
  it("types the cash-equity series as equity", () => {
    for (const s of ["EQ", "BE", "BZ", "SM", "ST"]) {
      assert.equal(
        classify("SOMECO", "NSE", s).klass,
        "EQUITY",
        `series ${s} should be equity`,
      );
    }
  });

  it("types the explicitly-classified non-equity series as debt", () => {
    // G-Secs, sovereign gold bonds, T-bills, state development loans.
    for (const s of ["GS", "GB", "TB", "SG"]) {
      assert.equal(
        classify("SOMEBOND", "NSE", s).klass,
        "DEBT",
        `series ${s} should be debt`,
      );
    }
  });

  it("types the churning debt FAMILIES as debt", () => {
    // NSE issues N0..NZ / Y0..YZ / Z0..ZZ and the second character churns —
    // 150 rows across ~50 codes in a single day's file.
    for (const s of ["N0", "NZ", "Y3", "Z9"]) {
      assert.equal(
        classify("SOMEBOND", "NSE", s).klass,
        "DEBT",
        `series ${s} should be debt`,
      );
    }
  });

  it("only matches a family on a TWO-character code", () => {
    // A bare "N" or a longer string must not fall into the N-family bucket.
    assert.notEqual(classify("SOMECO", "NSE", "N").klass, "DEBT");
    assert.notEqual(classify("SOMECO", "NSE", "NABC").klass, "DEBT");
  });

  it("abstains on an unrecognised series instead of guessing", () => {
    const r = classify("SOMECO", "NSE", "QQ");
    assert.equal(r.klass, "UNKNOWN");
    assert.match(r.reason, /unrecognised/);
  });
});

describe("the regex traps — why a symbol pattern cannot do this", () => {
  it("classifies digit-leading REAL equities as equity", () => {
    // Every one of these is a genuine listed company that the candidate
    // regex either matched (wrongly) or that made the pattern unusable.
    // Groups are the actual values from the 2026-07-29 BSE file.
    const realEquities: Array<[string, string]> = [
      ["3MINDIA", "A"],
      ["63MOONS", "A"],
      ["1STCUS", "X"],
      ["3PLAND", "B"],
      ["20MICRONS", "B"],
      ["5PAISA", "B"],
    ];
    for (const [symbol, group] of realEquities) {
      assert.equal(
        classify(symbol, "BSE", group).klass,
        "EQUITY",
        `${symbol} is a real equity and must not be typed debt`,
      );
    }
  });

  it("classifies non-digit-leading REAL debt as debt", () => {
    // These are bonds the regex MISSED, so a pattern-based fix would have
    // left them in the equity universe.
    for (const symbol of ["EPDPGSEC28", "CSAI240226", "NWFL24226"]) {
      assert.equal(
        classify(symbol, "BSE", "F").klass,
        "DEBT",
        `${symbol} is debt and the group says so even though its symbol does not`,
      );
    }
  });
});

describe("ETFs and trusts are identified before the series check", () => {
  it("types an ETF from its name/symbol regardless of group", () => {
    assert.equal(classify("NIFTYBEES", "NSE", "EQ").klass, "ETF");
    assert.equal(
      classifyCashInstrument({
        symbol: "SOMEFUND",
        name: "SBI Gold Exchange Traded Fund",
        exchange: "BSE",
        series: "A",
        isin: null,
        segmentCode: null,
      }).klass,
      "ETF",
    );
  });

  it("types REITs and InvITs from the NSE series", () => {
    assert.equal(classify("BIRET", "NSE", "RR").klass, "REIT");
    assert.equal(classify("PGINVIT", "NSE", "IV").klass, "INVIT");
  });

  it("types REITs and InvITs from the name when no series says so", () => {
    // A trust in an ordinary equity group would otherwise be compared
    // against operating companies on P/E — the MONEY-1085 lesson.
    assert.equal(
      classifyCashInstrument({
        symbol: "NXST",
        name: "NEXUS SELECT TRUST REIT",
        exchange: "BSE",
        series: "A",
        isin: null,
        segmentCode: null,
      }).klass,
      "REIT",
    );
    assert.equal(
      classifyCashInstrument({
        symbol: "IRBINVIT",
        name: "IRB INFRASTRUCTURE INVESTMENT TRUST",
        exchange: "BSE",
        series: "A",
        isin: null,
        segmentCode: null,
      }).klass,
      "INVIT",
    );
  });
});

describe("abstention — absence of a series is never 'therefore equity'", () => {
  it("returns UNKNOWN when no series has ever been observed", () => {
    // A bhavcopy only contains what TRADED that day (4,845 BSE rows against
    // 12,674 active BSE instruments), so most rows start with no series.
    assert.equal(classify("SOMECO", "BSE", null).klass, "UNKNOWN");
    assert.equal(classify("SOMECO", "NSE", null).klass, "UNKNOWN");
    assert.equal(classify("SOMECO", "BSE", "").klass, "UNKNOWN");
  });

  it("returns UNKNOWN for an exchange it cannot reason about", () => {
    assert.equal(classify("AAPL", "NASDAQ", "EQ").klass, "UNKNOWN");
  });

  it("never reports UNKNOWN as non-equity", () => {
    // The retype must skip these entirely. Retyping on a guess is exactly
    // how 2,200 bonds acquired a sector.
    assert.equal(isNonEquityClass("UNKNOWN"), false);
  });
});

describe("isNonEquityClass", () => {
  it("covers debt and both trust types", () => {
    assert.equal(isNonEquityClass("DEBT"), true);
    assert.equal(isNonEquityClass("REIT"), true);
    assert.equal(isNonEquityClass("INVIT"), true);
  });

  it("excludes EQUITY and ETF", () => {
    // ETF already has its own instrumentType and is not "wrongly EQUITY".
    assert.equal(isNonEquityClass("EQUITY"), false);
    assert.equal(isNonEquityClass("ETF"), false);
  });
});

describe("no drift from the price feed's series knowledge", () => {
  it("reuses bhavcopy's lists rather than re-declaring them", () => {
    // If these ever diverge, an instrument can be PRICED by a series the
    // classifier calls debt (or vice versa) — the MONEY-1085 failure shape.
    // Reading them here proves the classifier is importing, not copying.
    assert.ok(NSE_CASH_SERIES.has("EQ"));
    assert.ok(NSE_SERIES_INTENTIONALLY_UNPRICED["GS"]);
    assert.ok(NSE_SERIES_FAMILIES_UNPRICED["N"]);
  });

  it("classifies every NSE_CASH_SERIES member as equity or a trust", () => {
    for (const s of NSE_CASH_SERIES) {
      if (!s) continue; // blank = main board, handled as UNKNOWN by design
      const k = classify("SOMECO", "NSE", s).klass;
      assert.ok(
        k === "EQUITY" || k === "REIT" || k === "INVIT",
        `series ${s} is priced as cash equity but classified ${k}`,
      );
    }
  });

  it("classifies every explicitly-unpriced NSE series as NON-EQUITY-OR-KNOWN", () => {
    // This used to assert every unpriced series is DEBT. That was the wrong
    // assumption: the pricing list also contains MF (fund units), E1
    // (partly-paid SHARES) and SZ (suspended SME equity), which are unpriced for
    // reasons other than being debt. What must hold is that each has an EXPLICIT
    // class — never an abstention — so the classifier says what it knows.
    for (const s of Object.keys(NSE_SERIES_INTENTIONALLY_UNPRICED)) {
      const k = classify("SOMECO", "NSE", s).klass;
      assert.notEqual(
        k,
        "UNKNOWN",
        `series ${s} is deliberately unpriced, so we KNOW what it is — it must ` +
          `not abstain`,
      );
    }
  });

  it("keeps BSE_DEBT_GROUPS exactly the measured debt groups", () => {
    assert.deepEqual([...BSE_DEBT_GROUPS].sort(), ["F", "G"]);
  });

  it("never lists a group as both equity and debt", () => {
    for (const g of BSE_DEBT_GROUPS) {
      assert.ok(
        !BSE_EQUITY_GROUPS.has(g),
        `group ${g} is in BOTH lists — the debt check runs first, so this would silently win`,
      );
    }
  });

  it("pins BSE_EQUITY_GROUPS to exactly the 12 MEASURED groups", () => {
    // Provenance guard. An earlier revision carried "W" and "DR", which appear
    // nowhere in the 2026-07-29 file — assumptions dressed as measurements. An
    // unverified entry defeats the allow-list: if BSE uses one for a debt
    // group, an un-sourced row gets a confident EQUITY. Adding a group must
    // mean someone counted it in a real file and updated this list.
    assert.deepEqual([...BSE_EQUITY_GROUPS].sort(), [
      "A",
      "B",
      "E",
      "IF",
      "M",
      "MS",
      "MT",
      "P",
      "T",
      "X",
      "XT",
      "Z",
    ]);
  });

  it('excludes "EQ" from the BSE equity groups', () => {
    // Load-bearing: "EQ" is the stamped default. If it ever enters this set,
    // every un-sourced BSE row silently becomes equity again.
    assert.ok(!BSE_EQUITY_GROUPS.has("EQ"));
  });
});

describe("the exchange's explicit debt series outranks a name guess", () => {
  it("types a debt-series row DEBT even when the name says Trust", () => {
    // The inversion: the name matcher used to run before every series check, so
    // a bond on NSE family N ("corporate bonds / NCDs") named "...Trust NCD"
    // came back INVIT on the strength of one word and never reached the DEBT
    // branch — then escaped RETYPE_CLASSES and stayed EQUITY forever.
    const r = classifyCashInstrument({
      symbol: "INDIGRIDNCD",
      name: "INDIGRID INFRASTRUCTURE TRUST NCD SERIES 2",
      exchange: "NSE",
      series: "N2",
      isin: null,
      segmentCode: null,
    });
    assert.equal(r.klass, "DEBT");
    assert.match(r.reason, /nse-series-family/);
  });

  it("does the same for an explicitly-classified debt series", () => {
    const r = classifyCashInstrument({
      symbol: "SGBTRUST",
      name: "SOVEREIGN GOLD BOND TRUST",
      exchange: "NSE",
      series: "GB",
      isin: null,
      segmentCode: null,
    });
    assert.equal(r.klass, "DEBT");
  });

  it("and for a BSE debt group", () => {
    const r = classifyCashInstrument({
      symbol: "SOMEBOND",
      name: "SOME INFRASTRUCTURE INVESTMENT TRUST BOND",
      exchange: "BSE",
      series: "F",
      isin: null,
      segmentCode: null,
    });
    assert.equal(r.klass, "DEBT");
  });

  it("STILL types a genuine trust on an equity series from its name", () => {
    // The ordering change must not cost the case it was introduced for: a REIT
    // sitting in an ordinary equity series would otherwise be compared against
    // operating companies on P/E (the MONEY-1085 lesson).
    assert.equal(
      classifyCashInstrument({
        symbol: "NXST",
        name: "NEXUS SELECT TRUST REIT",
        exchange: "BSE",
        series: "A",
        isin: null,
        segmentCode: null,
      }).klass,
      "REIT",
    );
    assert.equal(
      classifyCashInstrument({
        symbol: "EMBASSY",
        name: "EMBASSY OFFICE PARKS REIT",
        exchange: "NSE",
        series: "EQ",
        isin: null,
        segmentCode: null,
      }).klass,
      "REIT",
    );
  });

  it("keeps the NSE trust SERIES as the strongest signal of all", () => {
    assert.equal(
      classifyCashInstrument({
        symbol: "BIRET",
        name: "anything at all",
        exchange: "NSE",
        series: "RR",
        isin: null,
        segmentCode: null,
      }).klass,
      "REIT",
    );
  });
});

describe("the NSE class map is separate from the PRICING list", () => {
  it("does not type partly-paid shares or suspended SME equity as DEBT", () => {
    // The classifier used to reuse NSE_SERIES_INTENTIONALLY_UNPRICED, a list
    // that answers "should the price feed skip this row?". Three of its eight
    // members are not debt: MF is fund units, E1 is partly-paid SHARES and SZ is
    // suspended SME equity. Typing those DEBT matters because a DEBT retype also
    // CLEARS sector/industry, from an unattended job with no rollback file.
    assert.equal(classify("SOMECO", "NSE", "E1").klass, "EQUITY");
    assert.equal(classify("SOMECO", "NSE", "SZ").klass, "EQUITY");
    assert.equal(classify("SOMEFUND", "NSE", "MF").klass, "MF");
  });

  it("still types the genuine debt series as DEBT", () => {
    for (const s of ["GS", "GB", "TB", "SG", "P1"]) {
      assert.equal(classify("SOMEBOND", "NSE", s).klass, "DEBT", `series ${s}`);
    }
  });

  it("covers EVERY member of the pricing list — no silent fall-through", () => {
    // Drift guard. A new unpriced series that is absent here would reach the
    // abstention branch and read as "we have no idea", which is a different and
    // less honest answer than "we know, and it is not equity".
    for (const s of Object.keys(NSE_SERIES_INTENTIONALLY_UNPRICED)) {
      assert.ok(
        NSE_SERIES_CLASS[s],
        `series ${s} is unpriced but has no explicit CLASS — add it to ` +
          `NSE_SERIES_CLASS rather than letting it abstain`,
      );
    }
  });

  it("agrees with the BSE segment map on preference shares", () => {
    // BSE files them under a PreferenceShares segment mapped to DEBT; the two
    // exchanges must not disagree about the same asset class.
    assert.equal(NSE_SERIES_CLASS["P1"], "DEBT");
  });
});
