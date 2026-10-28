/**
 * Tests for the AMFI scheme bridge (MONEY-1105).
 *
 * These run against a TRIMMED BUT VERBATIM capture of the real NAVAll feed,
 * committed at `__tests__/fixtures/amfi-navall/NAVAll.trimmed.txt`. Only WHOLE
 * lines were dropped — every retained line, including the CRLF endings and the
 * single-SPACE separator lines, is byte-identical to what AMFI served on
 * 2026-08-14. That matters more than usual here, because the two hardest things
 * about this feed are its LINE GRAMMAR (two interleaved kinds of header, one of
 * which is optional) and the junk values in its ISIN columns. A synthetic
 * fixture would have been written by whoever wrote the parser, i.e. it would
 * have agreed with the parser by construction and proved nothing.
 *
 * The four AMCs that have committed portfolio workbooks — SBI, Nippon, HDFC and
 * ABSL — are kept in FULL, so the resolve rate measured below is the same number
 * the live feed produces (verified: 326/333 either way). Five more AMCs are kept
 * trimmed, each because it demonstrates a grammar deformity.
 *
 * Each block names the silent-wrong-answer it exists to prevent. The recurring
 * theme is that every failure mode of this module is quiet: a shape change that
 * returns `[]` reads as "no schemes today", a coerced date reads as a real one,
 * and a guessed scheme code reads as a perfectly good join while attributing one
 * fund's holdings to another.
 *
 * Runtime note: the four AMC workbooks are opened with `onlySheets`, which parses
 * only their `Index` sheet (~0.9 s combined) instead of the ~330 portfolio
 * sheets. Everything is synchronous — no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMFI_NAVALL_URL,
  buildSchemeIndex,
  parseNavAllDate,
  parseNavAllGroups,
  reportSchemeCoverage,
  resolveSchemeCode,
  schemeFamilyKey,
  schemeFamilyTokens,
  type NavAllFile,
  type NavAllScheme,
  type SchemeIndex,
} from "../../src/market-data/amfi-scheme-bridge";
import { parseAmcPortfolioWorkbook } from "../../src/market-data/mf-portfolio-logic";

const NAVALL_FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "amfi-navall",
  "NAVAll.trimmed.txt",
);

/** Read + parse once; every assertion below reads the same immutable result. */
const TEXT = readFileSync(NAVALL_FIXTURE, "utf8");
const FEED: NavAllFile = (() => {
  const parsed = parseNavAllGroups(TEXT);
  assert.ok(parsed, "the committed fixture must parse");
  return parsed;
})();
const INDEX: SchemeIndex = buildSchemeIndex(FEED);

const SBI = "SBI Mutual Fund";
const NIPPON = "Nippon India Mutual Fund";
const HDFC = "HDFC Mutual Fund";
const ABSL = "Aditya Birla Sun Life Mutual Fund";

function group(amcName: string): readonly NavAllScheme[] {
  const g = FEED.groups.find((x) => x.amcName === amcName);
  assert.ok(g, `fixture must contain the group ${amcName}`);
  return g.schemes;
}

function scheme(amcName: string, schemeCode: string): NavAllScheme {
  const s = group(amcName).find((x) => x.schemeCode === schemeCode);
  assert.ok(s, `fixture must contain scheme ${schemeCode}`);
  return s;
}

/** Resolve and require a match; returns the codes. */
function codesFor(fundName: string, schemeName: string): readonly string[] {
  const r = resolveSchemeCode(INDEX, { amc: { fundName }, schemeName });
  assert.equal(r.status, "matched", `${schemeName} should resolve`);
  return r.status === "matched" ? r.schemeCodes : [];
}

/* -------------------------------------------------------------------------- */

describe("parseNavAllGroups — the live feed's real grammar", () => {
  it("recovers the four full AMC groups at their live scheme counts", () => {
    // These are the counts the LIVE feed produces for the same four AMCs. If
    // trimming the fixture had broken the AMC carry-over, these would drift and
    // nothing else in the file would notice.
    assert.equal(group(SBI).length, 485);
    assert.equal(group(NIPPON).length, 1865);
    assert.equal(group(HDFC).length, 568);
    assert.equal(group(ABSL).length, 461);
    assert.equal(FEED.schemeCount, 3627);
  });

  it("reads a whole scheme row exactly, including which ISIN column is which", () => {
    // Column 2 is `ISIN Div Payout/ ISIN Growth` and column 3 is
    // `ISIN Div Reinvestment`. Swapping them is undetectable downstream —
    // both are valid ISINs of the same fund — so both directions are pinned.
    const growth = scheme(SBI, "125503");
    assert.equal(
      growth.schemeName,
      "SBI BANKING & PSU FUND - Direct Plan - Growth",
    );
    assert.equal(growth.isinGrowth, "INF200K01V08");
    assert.equal(growth.isinReinvestment, null);
    assert.equal(growth.nav, 3533.0201);
    assert.equal(growth.navDate, "2026-08-13");
    assert.equal(
      growth.section,
      "Open Ended Schemes(Debt Scheme - Banking and PSU Fund)",
    );

    const reinvest = scheme(SBI, "125502");
    assert.equal(reinvest.isinGrowth, null);
    assert.equal(reinvest.isinReinvestment, "INF200K01V16");
  });

  it("separates SECTION headers from AMC headers", () => {
    // `amfi-mf-provider.parseAmfiFeed` USED to treat every semicolon-free line
    // as an AMC name, so on the live feed 16 rows carried `amcName = "Open
    // Ended Schemes(Growth)"`. Fixed in MONEY-1198 by lifting this module's
    // SECTION_HEADER discriminator into that provider; the regression lives in
    // `amfi-mf-provider.test.ts`. Kept asserted HERE too, because this module
    // is where the grammar is derived — if the split stops holding, it stops
    // holding for both readers.
    // No group here may ever be named after a section.
    assert.ok(FEED.sections.length >= 80, "the fixture keeps most sections");
    for (const g of FEED.groups) {
      assert.doesNotMatch(
        g.amcName,
        /Schemes?\(/,
        `${g.amcName} is a section header, not an AMC`,
      );
    }
    assert.ok(
      FEED.sections.includes("Open Ended Schemes(Growth)"),
      "the fixture keeps the section that has no AMC header of its own",
    );
  });

  it("carries the AMC across a section that has no AMC header", () => {
    // Three live sections carry no AMC header; their rows belong to the AMC of
    // the previous section. Resetting the AMC at a section boundary would drop
    // these rows entirely; defaulting to a sentinel would file them under a
    // fake AMC. Both failures are silent.
    const icici = scheme("ICICI Prudential Mutual Fund", "103028");
    assert.equal(icici.section, "Open Ended Schemes(Growth)");
    assert.match(icici.schemeName, /^ICICI Prudential Blended Plan A/);

    const zerodha = scheme("Zerodha Mutual Fund", "154437");
    assert.equal(
      zerodha.section,
      "Open Ended Schemes(Life Cycle Funds - Life Cycle Fund with Maturity of 15 Years)",
    );
    assert.match(zerodha.schemeName, /^Zerodha Life Cycle Fund 2041/);
  });

  it("keeps an AMC whose name does not end in 'Mutual Fund'", () => {
    // `IL&FS Mutual Fund (IDF)` breaks the obvious suffix heuristic AND
    // parenthesises like a section header. Losing it loses a whole AMC quietly.
    const ilfs = group("IL&FS Mutual Fund (IDF)");
    assert.ok(ilfs.length > 0);
    assert.equal(ilfs[0]!.section, "Close Ended Schemes(Income)");
  });

  it("nulls an ISIN column that does not hold an ISIN", () => {
    // Across the live feed these columns carry `-` 10,547 times, the literal
    // `Redeemed` 9 times, and once the ETF ticker `HDFCNIVODG`. An
    // `isin === "Redeemed"` reaching a join key is worse than an absent one.
    const redeemed = scheme("IL&FS Mutual Fund (IDF)", "130565");
    assert.equal(redeemed.isinGrowth, "INF613Q01025");
    assert.equal(redeemed.isinReinvestment, null);
    assert.ok(
      TEXT.includes(";Redeemed;"),
      "the fixture must still contain the raw junk value",
    );
  });

  it("publishes the CANONICAL feed URL, not the one that 302s", () => {
    // This assertion used to pin `www.amfiindia.com`, with a title that noted
    // the redirect — i.e. the move was seen and not made. MONEY-1198 makes it,
    // because "works via a 302" is a dependency on a hop nobody controls:
    // `fetch` follows redirects by default, so the www form kept working and
    // would have gone on working right up until a `redirect: "manual"`, a
    // non-following fetch wrapper, or a host-scoped egress rule broke the whole
    // MF NAV ingest with no code change to blame it on.
    //
    // Verified 2026-08-14: www -> 302 -> portal; portal -> 200, 1,649,879 bytes.
    assert.equal(
      AMFI_NAVALL_URL,
      "https://portal.amfiindia.com/spages/NAVAll.txt",
    );
  });
});

describe("parseNavAllGroups — null is not an empty list", () => {
  it("returns null, never [], for bytes that are not this feed", () => {
    // REGRESSION: "AMFI restructured the feed" and "AMFI lists no schemes" must
    // not be the same value. The second is impossible, so a caller seeing `[]`
    // would log a total parse failure as a successful empty run.
    for (const junk of [
      "",
      "<html><body>404 Not Found</body></html>",
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
      "just some prose with no semicolons at all",
    ]) {
      assert.equal(parseNavAllGroups(junk), null, JSON.stringify(junk));
    }
  });

  it("keeps a group with zero schemes as a real value", () => {
    // The counterpart to the rule above: an AMC that published nothing is a
    // legitimate answer and must stay distinguishable from a failed parse.
    const parsed = parseNavAllGroups(
      [
        "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
        " ",
        "Open Ended Schemes(Growth)",
        " ",
        "Empty Mutual Fund",
        " ",
        "Probe Mutual Fund",
        " ",
        "1;-;-;Probe Fund - Direct Plan - Growth;10;13-Aug-2026",
      ].join("\r\n"),
    );
    assert.ok(parsed);
    assert.deepEqual(
      parsed.groups.map((g) => [g.amcName, g.schemes.length]),
      [
        ["Empty Mutual Fund", 0],
        ["Probe Mutual Fund", 1],
      ],
    );
  });
});

describe("parse boundary — malformed values are absent, never coerced", () => {
  const HEADER =
    "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date";

  function probe(rows: readonly string[]): NavAllFile {
    const parsed = parseNavAllGroups(
      [
        HEADER,
        " ",
        "Open Ended Schemes(Growth)",
        " ",
        "Probe Mutual Fund",
        " ",
        ...rows,
      ].join("\r\n"),
    );
    assert.ok(parsed);
    return parsed;
  }

  it("rejects a date it cannot parse instead of coercing it", () => {
    // REGRESSION: `new Date("31-Feb-2026")` — what `amfi-mf-provider.parseAmfiDate`
    // reaches for — rolls forward to March 3rd. A NAV date that is silently a
    // real-looking wrong day is worse than an absent one.
    assert.equal(parseNavAllDate("13-Aug-2026"), "2026-08-13");
    assert.equal(parseNavAllDate("1-Jan-2020"), "2020-01-01");
    assert.equal(parseNavAllDate("  13-aug-2026 "), "2026-08-13");
    for (const bad of [
      "31-Feb-2026",
      "2026-08-13",
      "13-Xxx-2026",
      "13/08/2026",
      "",
    ]) {
      assert.equal(parseNavAllDate(bad), null, bad);
    }
  });

  it("keeps the row when only the NAV is bad", () => {
    // The scheme CODE is this module's payload. Dropping a row over its price —
    // which is what a NAV sync correctly does — would throw away a join key to
    // save nothing.
    const parsed = probe([
      "1;-;-;Probe Trailing Point Fund - Growth;10.;13-Aug-2026",
      "2;-;-;Probe Empty Nav Fund - Growth;;13-Aug-2026",
      "3;-;-;Probe Na Fund - Growth;N.A.;13-Aug-2026",
      "4;-;-;Probe Zero Fund - Growth;0;13-Aug-2026",
      "5;-;-;Probe Infinite Fund - Growth;Infinity;13-Aug-2026",
      "6;-;-;Probe Bad Date Fund - Growth;12.5;31-Feb-2026",
    ]);
    const byCode = new Map(
      parsed.groups[0]!.schemes.map((s) => [s.schemeCode, s]),
    );
    assert.equal(parsed.groups[0]!.schemes.length, 6, "no row is dropped");
    // "10." is a real live spelling on 17 rows and IS a number.
    assert.equal(byCode.get("1")!.nav, 10);
    // `Number("")` is 0, which is why the empty string needs its own guard.
    assert.equal(byCode.get("2")!.nav, null);
    assert.equal(byCode.get("3")!.nav, null);
    assert.equal(
      byCode.get("4")!.nav,
      null,
      "a NAV is a price; 0 is malformed",
    );
    assert.equal(byCode.get("5")!.nav, null);
    assert.equal(byCode.get("6")!.nav, 12.5);
    assert.equal(byCode.get("6")!.navDate, null);
  });

  it("rejects a row with no join key", () => {
    // `schemeCount` is the assertion — MONEY-1401 review finding 14 deleted
    // `rejectedRows`, whose only reader in three releases was this line. Three
    // bad rows and one good one must yield exactly one scheme, and a parser
    // that started admitting half-records breaks that number.
    const parsed = probe([
      "7;-;-;Probe Short Row Fund;9.9",
      ";-;-;Probe No Code Fund - Growth;9.9;13-Aug-2026",
      "9;-;-;;9.9;13-Aug-2026",
      "10;-;-;Probe Good Fund - Growth;9.9;13-Aug-2026",
    ]);
    assert.equal(parsed.schemeCount, 1);
    assert.deepEqual(
      parsed.groups.flatMap((g) => g.schemes.map((x) => x.schemeCode)),
      ["10"],
      "only the well-formed row may survive",
    );
  });

  it("rejects a row that appears before any AMC header", () => {
    // Never invents an "Unknown AMC" bucket: a sentinel group is
    // indistinguishable from a real one once it is downstream.
    const parsed = parseNavAllGroups(
      [
        HEADER,
        " ",
        "Open Ended Schemes(Growth)",
        " ",
        "1;-;-;Orphan Fund - Growth;10;13-Aug-2026",
        " ",
        "Probe Mutual Fund",
        " ",
        "2;-;-;Probe Fund - Growth;10;13-Aug-2026",
      ].join("\r\n"),
    );
    assert.ok(parsed);
    assert.deepEqual(
      parsed.groups.map((g) => g.amcName),
      ["Probe Mutual Fund"],
    );
    // The orphan is GONE, not filed under a sentinel AMC — the property
    // `rejectedRows` used to stand in for.
    assert.equal(parsed.schemeCount, 1);
  });
});

describe("schemeFamilyKey — one portfolio, one key", () => {
  it("collapses Direct and Regular of one scheme onto ONE family", () => {
    // REGRESSION: a Direct and a Regular plan hold IDENTICAL securities and
    // differ only in expense ratio; the workbook publishes one portfolio for
    // both. Keeping them apart duplicates every holding and double-counts
    // "which funds hold RELIANCE".
    const keys = [
      "SBI Corporate Bond Fund - Direct Plan - Growth",
      "SBI Corporate Bond Fund - Regular Plan - Growth",
      "SBI Corporate Bond Fund - Direct Plan - Monthly Income Distribution cum Capital Withdrawal Option (IDCW)",
      "SBI Corporate Bond Fund - Regular Plan - Quarterly Income Distribution cum Capital Withdrawal Option (IDCW)",
      "SBI Corporate Bond Fund",
    ].map(schemeFamilyKey);
    assert.deepEqual(new Set(keys), new Set(["SBICORPORATEBONDFUND"]));
  });

  it("collapses AMFI's own 'Paln' typo with the correct spelling", () => {
    // Live rows: `SBI BANKING & PSU FUND - Regular Paln - Growth`. There is no
    // upstream to fix it in.
    assert.equal(
      schemeFamilyKey("SBI BANKING & PSU FUND - Regular Paln - Growth"),
      schemeFamilyKey("SBI Banking & PSU Fund - Direct Plan - Growth"),
    );
  });

  it("treats '&' and 'and' as the same word", () => {
    assert.equal(
      schemeFamilyKey("SBI Banking & PSU Fund"),
      schemeFamilyKey("SBI Banking and PSU Fund"),
    );
  });

  it("absorbs the AMCs' inconsistent word boundaries", () => {
    // The SBI workbook prints `Midcap150` where NAVAll prints `Midcap 150`;
    // `Flexicap`/`Flexi Cap` and `Midcap`/`Mid Cap` both occur in the feed.
    // Joining the tokens with a separator loses 5 of the 333 real sheet names.
    assert.equal(
      schemeFamilyKey("SBI Nifty Midcap150 ETF"),
      schemeFamilyKey("SBI Nifty Midcap 150 ETF"),
    );
  });

  it("folds 'FoF' onto 'Fund of Funds'", () => {
    // ABSL is `… Silver ETF FOF-Direct Growth` in NAVAll and
    // `… SILVER ETF FUND OF FUND` in its own workbook.
    assert.equal(
      schemeFamilyKey("Aditya Birla Sun Life Silver ETF FOF-Direct Growth"),
      schemeFamilyKey("ADITYA BIRLA SUN LIFE SILVER ETF FUND OF FUND"),
    );
  });

  it("strips only a TRAILING run, so a noise word inside a name survives", () => {
    // REGRESSION: the plan/option vocabulary contains GROWTH, INCOME, CAPITAL,
    // REGULAR and DIVIDEND. A set-membership filter over the whole name — the
    // obvious implementation — would silently mutilate all five of these into
    // a different fund.
    assert.equal(
      schemeFamilyKey("Nippon India Growth Mid Cap Fund"),
      "NIPPONINDIAGROWTHMIDCAPFUND",
    );
    assert.equal(
      schemeFamilyKey("ADITYA BIRLA SUN LIFE INCOME FUND"),
      "ADITYABIRLASUNLIFEINCOMEFUND",
    );
    assert.equal(
      schemeFamilyKey("WhiteOak Capital Flexi Cap Fund"),
      "WHITEOAKCAPITALFLEXICAPFUND",
    );
    assert.equal(
      schemeFamilyKey("SBI Dividend Yield Fund"),
      "SBIDIVIDENDYIELDFUND",
    );
    assert.equal(
      schemeFamilyKey("Aditya Birla Sun Life Regular Savings Fund"),
      "ADITYABIRLASUNLIFEREGULARSAVINGSFUND",
    );
  });

  it("sees through a connector inside the option suffix", () => {
    // `- Direct - Monthly Payout of IDCW` stops a naive reverse walk dead at
    // `of`, leaving half the option description welded to the family key.
    assert.equal(
      schemeFamilyKey(
        "ADITYA BIRLA SUN LIFE OVERNIGHT FUND-  Direct - Monthly Payout of IDCW",
      ),
      schemeFamilyKey("Aditya Birla Sun Life Overnight Fund - Direct - Growth"),
    );
  });

  it("strips NESTED parentheticals, not just the innermost", () => {
    // REGRESSION: `/\([^)]*\)/g` closes on the INNER paren of Nippon's category
    // sentence and leaves the outer tail in the name. That alone cost 6 of
    // Nippon's 107 sheets a match.
    assert.equal(
      schemeFamilyKey(
        "Nippon India Floater Fund (An open ended debt scheme predominantly investing in floating rate instruments (including fixed rate instruments converted to floating rate exposures using swaps/ derivatives). Relatively High interest rate risk and moderate Credit Risk. )",
      ),
      "NIPPONINDIAFLOATERFUND",
    );
  });

  it("collapses the scheme name Nippon prints twice", () => {
    // Nippon writes `<scheme> (<sebi category>) <scheme>-Segregated Portfolio N`.
    // Recovered 5 of its 107 sheets.
    assert.equal(
      schemeFamilyKey(
        "NIPPON INDIA EQUITY SAVINGS FUND (An open ended scheme investing in equity, arbitrage and debt) Nippon India Equity Savings Fund - Segregated Portfolio 2",
      ),
      "NIPPONINDIAEQUITYSAVINGSFUNDSEGREGATEDPORTFOLIO2",
    );
  });

  it("exposes the token split, and admits it is not canonical", () => {
    // The key is separator-free by design and cannot be split back apart, so the
    // split form is exported for the token-aligned comparisons that decide
    // ambiguity. It is NOT canonical per family — the same key can come from two
    // different splits — and pinning that here stops a future reader treating
    // `tokens` as an identity.
    assert.deepEqual(
      schemeFamilyTokens("SBI Corporate Bond Fund - Direct Plan - Growth"),
      ["SBI", "CORPORATE", "BOND", "FUND"],
    );
    assert.equal(
      schemeFamilyKey("SBI Nifty Midcap150 ETF"),
      schemeFamilyKey("SBI Nifty Midcap 150 ETF"),
    );
    assert.notDeepEqual(
      schemeFamilyTokens("SBI Nifty Midcap150 ETF"),
      schemeFamilyTokens("SBI Nifty Midcap 150 ETF"),
    );
    assert.equal(
      schemeFamilyTokens("SBI Corporate Bond Fund").join(""),
      "SBICORPORATEBONDFUND",
    );
  });

  it("returns '' for a name that is nothing but plan and option words", () => {
    // `""` is never indexed and never matches, so it cannot become a wildcard
    // that swallows every unresolvable lookup.
    assert.equal(schemeFamilyKey("Direct Plan - Growth"), "");
    assert.equal(schemeFamilyKey(""), "");
    assert.equal(schemeFamilyKey("   -  "), "");
  });
});

describe("buildSchemeIndex — every scheme lands in exactly one family", () => {
  it("partitions the feed: no scheme is dropped and none is counted twice", () => {
    // The invariant that makes a coverage report meaningful. A scheme silently
    // missing from the index resolves as `no-match` forever and looks like an
    // upstream naming problem; a scheme in two families makes one of them wrong.
    const seen = new Map<string, string>();
    let indexed = 0;
    for (const amc of INDEX.amcs) {
      for (const family of amc.families) {
        assert.equal(
          family.tokens.join(""),
          family.key,
          "a family's tokens must rebuild its key",
        );
        assert.ok(family.key.length > 0, "an empty key is never indexed");
        for (const code of family.schemeCodes) {
          assert.equal(
            seen.get(code),
            undefined,
            `scheme ${code} is in two families`,
          );
          seen.set(code, family.key);
          indexed++;
        }
      }
    }
    assert.equal(indexed, FEED.schemeCount);
    assert.equal(seen.size, FEED.schemeCount);
  });

  it("keeps the AMC name byte-identical to the registry's fundName", () => {
    // The whole mfId -> fundName -> NAVAll-group join rests on this exactness.
    // Trimming or case-folding here is how an exact join quietly becomes a
    // 96%-exact one.
    const names = INDEX.amcs.map((a) => a.amcName);
    assert.ok(names.includes(SBI));
    assert.ok(names.includes("IL&FS Mutual Fund (IDF)"));
    for (const n of names) assert.equal(n, n.trim());
  });
});

describe("resolveSchemeCode — it refuses to guess", () => {
  it("returns the family's scheme codes for an exact match", () => {
    assert.deepEqual(codesFor(SBI, "SBI Corporate Bond Fund"), [
      "146215",
      "146212",
      "146216",
      "146207",
      "146208",
      "146210",
    ]);
    // HDFC's single-scheme workbook prints the SEBI category sentence inline.
    assert.deepEqual(
      codesFor(
        HDFC,
        "HDFC Value Fund (An open ended equity scheme following a value investment strategy)",
      ),
      ["118935", "101764", "118934", "101765"],
    );
  });

  it("REFUSES to pick one of several families for an under-specified name", () => {
    // THE test. `Aditya Birla Sun Life Retirement Fund` is three (four, with the
    // 50s-Plus-Debt plan) different funds holding materially different books.
    // Silently choosing the first would attribute a 30-year-old's equity
    // portfolio to a retiree's debt one, and every log line would read as a
    // successful join.
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: ABSL },
      schemeName: "Aditya Birla Sun Life Retirement Fund",
    });
    assert.equal(r.status, "ambiguous");
    if (r.status !== "ambiguous") return;
    assert.deepEqual(r.candidates.map((c) => c.key).sort(), [
      "ADITYABIRLASUNLIFERETIREMENTFUNDTHE30S",
      "ADITYABIRLASUNLIFERETIREMENTFUNDTHE40S",
      "ADITYABIRLASUNLIFERETIREMENTFUNDTHE50S",
      "ADITYABIRLASUNLIFERETIREMENTFUNDTHE50SPLUSDEBT",
    ]);
    // Every candidate carries its own evidence, and none of them is elected.
    for (const c of r.candidates) {
      assert.equal(c.schemeCodes.length, 4);
      assert.match(c.sampleName, /Retirement Fund/);
    }
    assert.ok(
      !Object.prototype.hasOwnProperty.call(r, "schemeCodes"),
      "an ambiguous resolution must not carry codes at all",
    );
  });

  it("does NOT promote a single extension to a match", () => {
    // `Nippon India Quarterly Interval Fund-Series 2` extends only to the feed's
    // `… SERIES II`, and a roman-numeral guess is still a guess. The near miss
    // is REPORTED so an operator can see it, and it is not usable as a code.
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: NIPPON },
      schemeName: "Nippon India Quarterly Interval Fund-Series 2",
    });
    assert.equal(r.status, "no-match");
    if (r.status !== "no-match") return;
    assert.deepEqual(
      r.nearest.map((n) => n.key),
      ["NIPPONINDIAQUARTERLYINTERVALFUNDSERIESII"],
    );
  });

  it("reports the nearest family for an abbreviated name, without using it", () => {
    // The SBI workbook prints `APR-2029` where the feed prints `April 2029`.
    // A bare zero tells an operator nothing; the near miss tells them exactly
    // what to fix.
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: SBI },
      schemeName: "SBI CRISIL IBX Gilt Index-APR-2029 Fund",
    });
    assert.equal(r.status, "no-match");
    if (r.status !== "no-match") return;
    assert.ok(
      r.nearest.some((n) => n.key === "SBICRISILIBXGILTINDEXAPRIL2029FUND"),
      "the April spelling must be surfaced as a near miss",
    );
  });

  it("says so when a scheme is simply not in the feed", () => {
    // `SBI Resurgent India Opportunities Scheme` appears ZERO times in the whole
    // live feed. No match is the correct answer, and inventing one is the
    // failure this module exists to prevent.
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: SBI },
      schemeName: "SBI Resurgent India Opportunities Scheme",
    });
    assert.equal(r.status, "no-match");
  });

  it("distinguishes an AMC that is not in the feed from a scheme that is not", () => {
    // The five registry AMCs with no NAVAll group (ASK, Carnelian, Lakshya,
    // Monarch, Nuvama) are newly licensed and have no live schemes. That is a
    // different fact from "we could not find this scheme", and it needs a
    // different remediation.
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: "ASK MUTUAL FUND" },
      schemeName: "ASK Flexi Cap Fund",
    });
    assert.equal(r.status, "amc-not-found");
  });

  it("matches the AMC name byte-exactly, never fuzzily", () => {
    // Same discipline as `findAmcByFundName`: the byte-identity of the NAVAll
    // group header to the registry's `fundName` IS the join. A fuzzy hit here
    // hands one AMC's scheme codes to another house.
    for (const near of [
      "SBI MUTUAL FUND",
      "SBI Mutual Fund ",
      "SBI Mutual  Fund",
      "sbi mutual fund",
    ]) {
      assert.equal(
        resolveSchemeCode(INDEX, {
          amc: { fundName: near },
          schemeName: "SBI Corporate Bond Fund",
        }).status,
        "amc-not-found",
        near,
      );
    }
  });

  it("reports amc-not-found for an mfId when no registry was supplied", () => {
    // `buildSchemeIndex` without a registry genuinely cannot map an id, and
    // saying so beats quietly falling back to a name comparison.
    assert.equal(
      resolveSchemeCode(INDEX, {
        amc: { mfId: "22" },
        schemeName: "SBI Midcap Fund",
      }).status,
      "amc-not-found",
    );
  });

  it("resolves by mfId once a registry is supplied", () => {
    const withRegistry = buildSchemeIndex(FEED, {
      amcs: [
        {
          mfId: "22",
          fundName: SBI,
          legalName: "SBI Funds Management Limited",
          website: null,
          monthlyPortfolioUrl: null,
          fortnightlyPortfolioUrl: null,
          halfYearlyPortfolioUrl: null,
          monthlyFactsheetUrl: null,
          schemeWiseAnnualReportUrl: null,
          rssNavUrl: null,
          rssAumUrl: null,
          statementOfInformationUrl: null,
        },
      ],
    });
    const r = resolveSchemeCode(withRegistry, {
      amc: { mfId: "22" },
      schemeName: "SBI Corporate Bond Fund",
    });
    assert.equal(r.status, "matched");
    if (r.status === "matched") assert.equal(r.amcName, SBI);
  });

  it("carries both ISINs of a family as the secondary join key", () => {
    const r = resolveSchemeCode(INDEX, {
      amc: { fundName: HDFC },
      schemeName: "HDFC Value Fund",
    });
    assert.equal(r.status, "matched");
    if (r.status !== "matched") return;
    assert.ok(r.family.isins.length >= 4);
    for (const isin of r.family.isins)
      assert.match(isin, /^IN[A-Z][A-Z0-9]{9}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* The measurement this module exists for                                      */
/* -------------------------------------------------------------------------- */

describe("coverage — real workbook sheet names against the real feed", () => {
  /** `[amcName, workbook, hasIndexSheet]`. */
  const WORKBOOKS: ReadonlyArray<readonly [string, string, boolean]> = [
    [SBI, "sbi-all-schemes-2026-07.xlsx", true],
    [NIPPON, "nippon-monthly-portfolio-2026-07.xls", true],
    [ABSL, "absl-monthly-portfolio-2026-07.zip", true],
    // HDFC publishes ONE FILE PER SCHEME, so this workbook has a single
    // portfolio sheet and no `Index` sheet to read names off. `onlySheets`
    // would skip its only sheet and silently yield zero names — which is
    // exactly how a coverage report grows a hole nobody notices.
    [HDFC, "hdfc-value-fund-2026-07.xlsx", false],
  ];

  /**
   * The scheme names as the AMC actually printed them, read out of the committed
   * workbooks rather than copied into this file. Copied names cannot drift with
   * the fixture; they also cannot catch the fixture drifting.
   *
   * For the three multi-scheme workbooks, `onlySheets` with a name no workbook
   * has parses the `Index` sheet and nothing else (see
   * `parseAmcPortfolioWorkbook`), which costs ~0.9 s instead of ~2 s of full
   * portfolio parsing. HDFC's single 155 KB sheet is parsed in full, at ~10 ms.
   */
  function printedNames(
    file: string,
    hasIndexSheet: boolean,
  ): readonly string[] {
    const bytes = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "amc", file),
    );
    const parsed = parseAmcPortfolioWorkbook(
      new Uint8Array(bytes),
      hasIndexSheet ? { onlySheets: ["__index_only__"] } : {},
    );
    assert.ok(parsed, `${file} must parse`);
    const names =
      parsed.index.length > 0
        ? parsed.index.map((e) => e.schemeName)
        : parsed.sheets
            .map((s) => s.schemeName)
            .filter((n): n is string => n !== null);
    assert.ok(names.length > 0, `${file} must yield printed scheme names`);
    return names;
  }

  it("resolves 326 of the 333 real sheet names, and names every failure", () => {
    // The headline number for MONEY-1105, measured — not estimated. It is
    // IDENTICAL against the live feed and against this trimmed fixture, which is
    // what makes the fixture worth committing.
    const perAmc = new Map<string, { total: number; resolved: number }>();
    let total = 0;
    let resolved = 0;
    let ambiguous = 0;
    let noMatch = 0;
    let codes = 0;

    for (const [amcName, file, hasIndexSheet] of WORKBOOKS) {
      const report = reportSchemeCoverage(
        INDEX,
        { fundName: amcName },
        printedNames(file, hasIndexSheet),
      );
      perAmc.set(amcName, { total: report.total, resolved: report.resolved });
      total += report.total;
      resolved += report.resolved;
      ambiguous += report.ambiguous;
      noMatch += report.noMatch;
      codes += report.schemeCodeCount;

      // The invariant that makes the report trustworthy.
      assert.equal(
        report.resolved +
          report.ambiguous +
          report.noMatch +
          report.amcNotFound,
        report.total,
        amcName,
      );
      assert.equal(report.unresolved.length, report.total - report.resolved);
      assert.equal(report.amcName, amcName);
    }

    assert.deepEqual(perAmc.get(SBI), { total: 121, resolved: 117 });
    assert.deepEqual(perAmc.get(NIPPON), { total: 107, resolved: 106 });
    assert.deepEqual(perAmc.get(ABSL), { total: 104, resolved: 102 });
    assert.deepEqual(perAmc.get(HDFC), { total: 1, resolved: 1 });

    assert.equal(total, 333);
    assert.equal(resolved, 326);
    assert.equal(noMatch, 7);
    // Zero ambiguous on real data: workbook names are specific enough. The
    // ambiguous PATH is still reachable and is pinned by its own test above —
    // this asserts the rate, not that the branch is dead.
    assert.equal(ambiguous, 0);
    // 1,349 distinct AMFI scheme codes recovered for 326 sheets — the join is
    // one-to-many by design, because a family is every plan and option of one
    // portfolio.
    assert.equal(codes, 1349);
  });

  it("explains each unresolved name rather than only counting it", () => {
    const report = reportSchemeCoverage(
      INDEX,
      { fundName: SBI },
      printedNames("sbi-all-schemes-2026-07.xlsx", true),
    );
    assert.equal(report.unresolved.length, 4);
    for (const entry of report.unresolved) {
      assert.equal(entry.status, "no-match");
      assert.equal(
        entry.schemeCodes.length,
        0,
        "an unresolved name yields NO codes",
      );
      assert.ok(entry.familyKey.length > 0);
    }
    // Three of the four are abbreviations of a scheme that IS in the feed, and
    // the report has to say which one so the abbreviation can be fixed.
    const withNearest = report.unresolved.filter(
      (e) => e.candidateKeys.length > 0,
    );
    assert.ok(withNearest.length >= 2, "near misses must be surfaced");
  });

  it("never yields a NaN rate for an empty sheet list", () => {
    const empty = reportSchemeCoverage(INDEX, { fundName: SBI }, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.resolvedRate, 0);
    assert.ok(Number.isFinite(empty.resolvedRate));
  });

  it("counts every name against a missing AMC without throwing", () => {
    const report = reportSchemeCoverage(
      INDEX,
      { fundName: "ASK MUTUAL FUND" },
      ["ASK Flexi Cap Fund", "ASK Value Fund"],
    );
    assert.equal(report.amcNotFound, 2);
    assert.equal(report.resolved, 0);
    assert.equal(report.amcName, null);
  });
});

describe("purity", () => {
  it("returns identical results for identical input, and mutates nothing", () => {
    // No clock, no network, no Prisma: two parses of the same bytes must be
    // deeply equal, and resolving must not disturb the index it reads.
    const a = parseNavAllGroups(TEXT);
    const b = parseNavAllGroups(TEXT);
    assert.deepEqual(a, b);

    const before = JSON.stringify(INDEX.amcs.map((x) => x.families.length));
    resolveSchemeCode(INDEX, {
      amc: { fundName: SBI },
      schemeName: "SBI Corporate Bond Fund",
    });
    resolveSchemeCode(INDEX, {
      amc: { fundName: ABSL },
      schemeName: "Aditya Birla Sun Life Retirement Fund",
    });
    assert.equal(
      JSON.stringify(INDEX.amcs.map((x) => x.families.length)),
      before,
    );
  });

  it("parses CRLF, LF and CR alike", () => {
    // The live feed is CRLF throughout, but an archived copy that has been
    // through a text-mode round trip is not, and that is not a reason to report
    // the feed as unreadable.
    const crlf = parseNavAllGroups(TEXT)!;
    const lf = parseNavAllGroups(TEXT.replace(/\r\n/g, "\n"))!;
    const cr = parseNavAllGroups(TEXT.replace(/\r\n/g, "\r"))!;
    assert.equal(lf.schemeCount, crlf.schemeCount);
    assert.equal(cr.schemeCount, crlf.schemeCount);
    assert.deepEqual(
      lf.groups.map((g) => g.amcName),
      crlf.groups.map((g) => g.amcName),
    );
  });
});
