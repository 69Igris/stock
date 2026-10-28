/**
 * UNIT TEST — SEBI shareholding-pattern XBRL parser (MONEY-1205).
 *
 * ## The fixtures are real filings, fetched 2026-08-18
 *
 * Their URLs came out of prod's own `shareholding_patterns.raw` (the `xbrl`
 * key of NSE's `/api/corporate-shareholding` payload) and were downloaded
 * cookieless from `nsearchives.nseindia.com/corporate/xbrl/…`. Four filings,
 * each carrying a shape the others do not:
 *
 * | fixture     | symbol     | quarter | why it is here                          |
 * |-------------|------------|---------|-----------------------------------------|
 * | bankbaroda… | BANKBARODA | 2026-06 | PSU bank: govt PROMOTER, full DII legs  |
 * | cub…        | CUB        | 2026-06 | no promoter table at all; public = 100% |
 * | bhartiartl… | BHARTIARTL | 2026-06 | Table IV trust; Table IV total has NO % |
 * | bedmutha…   | BEDMUTHA   | 2026-06 | pledged promoter; ZERO institutions     |
 *
 * ## Values are checked against NSE's SUMMARY row, not against this parser
 *
 * Every promoter/public figure asserted below is the number NSE's own
 * `/api/corporate-shareholding` summary published for the same (symbol,
 * quarter) — read out of prod: BANKBARODA 63.97/36.03, CUB 0/100,
 * BHARTIARTL 50.07/49.89 with `employeeTrusts: "0.04"`, BEDMUTHA 57.09/42.91.
 * So a regression shows up as a wrong REAL number that two independent NSE
 * surfaces contradict, not as a diff against a golden blob.
 *
 * ## The load-bearing cases
 *
 * 1. `reads percentages as FRACTIONS`. The filings state `unitRef="pure"`
 *    ratios: Bank of Baroda's promoter holding is `0.6397`. Taking it at face
 *    value turns a 64%-promoter PSU into a 0.64%-promoter shell.
 * 2. `promoter pledge is a share of the PROMOTER's holding`. The element is
 *    named `…AsPercentageOfTotalNumberOfShares` and, under the promoter
 *    context, is not that. BEDMUTHA files both readings — 94.99 and 54.23 —
 *    from the same 17,496,105 pledged shares.
 * 3. `diiPct is the filed total, never the sum of the legs we model`. Bank of
 *    Baroda's filed DII is 18.42%; this schema's legs come to 16.01%. The 2.41
 *    points are provident/pension, domestic sovereign wealth and NBFCs — real
 *    holdings with no column here, which a derived total would silently drop.
 * 4. `absence stays null`. CUB has no promoter row, BEDMUTHA no institutions,
 *    BHARTIARTL no Table IV percentage. `Number("")` is 0, and each of these is
 *    a place where that 0 would be indistinguishable from a filed one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RECONCILE_TOLERANCE_PCT,
  inspectShareholdingXbrl,
  parseShareholdingXbrl,
  reconcileWithSummary,
  type ShareholdingBreakdownParse,
} from "../../src/market-data/shareholding-xbrl";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "shp-xbrl");
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const BANKBARODA_XML = read("bankbaroda-2026-06-psu-bank.xml");
const CUB_XML = read("cub-2026-06-zero-promoter-bank.xml");
const BHARTIARTL_XML = read("bhartiartl-2026-06-nonbank.xml");
const BEDMUTHA_XML = read("bedmutha-2026-06-pledged.xml");

/**
 * The body NSE actually serves for `…/corporate/xbrl/-`, the well-formed but
 * document-less URL its metadata emits when a filing has no XBRL. Reused from
 * the results-XBRL fixtures rather than re-captured: it is the same door, and
 * 89 of prod's 7,953 summary rows point at exactly this.
 */
const NOT_FOUND_HTML = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "fixtures",
    "xbrl",
    "nse-missing-xbrl-404.html",
  ),
  "utf8",
);

/** Parse-or-fail, so a `null` regression fails on an assertion, not a TypeError. */
function parsed(xml: string): ShareholdingBreakdownParse {
  const r = parseShareholdingXbrl(xml);
  assert.ok(r !== null, "expected the document to parse");
  return r;
}

/* -------------------------------------------------------------------------- */
/* Synthetic instances — for shapes the real filings do not contain            */
/* -------------------------------------------------------------------------- */

interface SynthCategory {
  member: string;
  pct?: string;
  shares?: string;
  pledgePct?: string;
}

/**
 * A minimal but structurally faithful SHP instance.
 *
 * Same namespace grammar, same axis, same element names as the real filings —
 * only the volume differs. Used for the shapes no real fixture supplies: a
 * percent-scaled document, a blank cell, a missing grand total, a >2^53 share
 * count.
 */
function synth(opts: {
  namespace?: string;
  symbol?: string | null;
  isin?: string | null;
  dateOfReport?: string | null;
  categories: SynthCategory[];
}): string {
  const ns =
    opts.namespace ?? "http://www.bseindia.com/xbrl/shp/2025-10-31/in-bse-shp";

  const contexts = opts.categories
    .map(
      (c) => `<xbrli:context id="${c.member}_ContextI">
  <xbrli:entity><xbrli:identifier scheme="http://www.bseindia.com/in-bse-shp/ScripCode">1</xbrli:identifier>
  <xbrli:segment><xbrldi:explicitMember dimension="in-bse-shp:CategoryOfShareholdersAxis">in-bse-shp:${c.member}</xbrldi:explicitMember></xbrli:segment>
  </xbrli:entity>
  <xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period>
</xbrli:context>`,
    )
    .join("");

  const facts = opts.categories
    .map((c) => {
      const ref = `${c.member}_ContextI`;
      const parts: string[] = [];
      if (c.pct !== undefined) {
        parts.push(
          `<in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="${ref}" decimals="INF" unitRef="pure">${c.pct}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>`,
        );
      }
      if (c.shares !== undefined) {
        parts.push(
          `<in-bse-shp:NumberOfShares contextRef="${ref}" decimals="INF" unitRef="shares">${c.shares}</in-bse-shp:NumberOfShares>`,
        );
      }
      if (c.pledgePct !== undefined) {
        parts.push(
          `<in-bse-shp:EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares contextRef="${ref}" decimals="INF" unitRef="pure">${c.pledgePct}</in-bse-shp:EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares>`,
        );
      }
      return parts.join("");
    })
    .join("");

  const id: string[] = [];
  if (opts.symbol !== null) {
    id.push(
      `<in-bse-shp:Symbol contextRef="MainD">${opts.symbol ?? "ACME"}</in-bse-shp:Symbol>`,
    );
  }
  if (opts.isin !== null && opts.isin !== undefined) {
    id.push(
      `<in-bse-shp:ISIN contextRef="MainD">${opts.isin}</in-bse-shp:ISIN>`,
    );
  }
  if (opts.dateOfReport !== null) {
    id.push(
      `<in-bse-shp:DateOfReport contextRef="MainI">${opts.dateOfReport ?? "2026-06-30"}</in-bse-shp:DateOfReport>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-shp="${ns}" xmlns:in-bse-shp-types="${ns}-types" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<xbrli:context id="MainD"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="MainI"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context>
${contexts}${id.join("")}${facts}</xbrli:xbrl>`;
}

/* ========================================================================== */

describe("parseShareholdingXbrl — the documents are reachable and readable", () => {
  it("reads Bank of Baroda Q1-FY27 (PSU bank) against NSE's own summary row", () => {
    const p = parsed(BANKBARODA_XML);

    assert.equal(p.symbol, "BANKBARODA");
    assert.equal(p.companyName, "Bank Of Baroda");
    assert.equal(p.scripCode, "532134");
    assert.equal(p.reportDate, "2026-06-30");
    assert.equal(p.quarter, "2026-06");
    assert.equal(p.taxonomyVersion, "2025-10-31");

    // NSE's summary row for the same quarter: pr_and_prgrp 63.97 / public 36.03.
    assert.equal(p.promoterPct, 63.97);
    assert.equal(p.publicPct, 36.03);

    // The whole reason this module exists — the summary carries NEITHER.
    assert.equal(p.fiiPct, 10.14);
    assert.equal(p.diiPct, 18.42);

    assert.equal(p.mutualFundPct, 9.78);
    assert.equal(p.insurancePct, 5.93);
    assert.equal(p.alternateInvPct, 0.24);
    assert.equal(p.retailPct, 5.67);

    assert.equal(p.totalShares, 5_171_362_179n);
    assert.equal(p.promoterShares, 3_308_184_689n);
    assert.equal(p.publicShares, 1_863_177_490n);
    assert.equal(p.diiShares, 952_622_762n);
  });

  it("reads a large bank's FII as tens of percent, not null", () => {
    // The defect this ticket exists to fix rendered as "no institutional
    // holders". A parser that regressed to null here would reproduce it while
    // every other assertion in this file still passed.
    for (const [name, xml, floor] of [
      ["BANKBARODA", BANKBARODA_XML, 10],
      ["CUB", CUB_XML, 18],
      ["BHARTIARTL", BHARTIARTL_XML, 26],
    ] as const) {
      const p = parsed(xml);
      assert.ok(
        p.fiiPct !== null && p.fiiPct >= floor && p.fiiPct <= 100,
        `${name}: expected FII ≥ ${floor}%, got ${String(p.fiiPct)}`,
      );
      assert.ok(
        p.diiPct !== null && p.diiPct >= 18 && p.diiPct <= 100,
        `${name}: expected DII ≥ 18%, got ${String(p.diiPct)}`,
      );
    }
  });

  it("reads City Union Bank — a bank with NO promoter at all", () => {
    const p = parsed(CUB_XML);
    assert.equal(p.symbol, "CUB");
    assert.equal(p.publicPct, 100);
    assert.equal(p.fiiPct, 18.65);
    assert.equal(p.diiPct, 44.85);
    assert.equal(p.mutualFundPct, 34.24);
    // Public IS the whole company, so both totals are 100%/all shares.
    assert.equal(p.publicShares, 990_787_237n);
    assert.equal(p.totalShares, 990_787_237n);
  });

  it("reads Bharti Airtel — non-bank, with a Table IV employee trust", () => {
    const p = parsed(BHARTIARTL_XML);
    assert.equal(p.symbol, "BHARTIARTL");
    assert.equal(p.promoterPct, 50.07);
    assert.equal(p.publicPct, 49.89);
    assert.equal(p.fiiPct, 26.51);
    assert.equal(p.diiPct, 20.76);
    // Summary row's `employeeTrusts` for the same quarter is "0.04".
    assert.equal(p.employeeTrustPct, 0.04);
    // The report date is NOT the quarter end here (23-Jun), and the quarter
    // still keys to 2026-06 — which is what joins this row to the summary.
    assert.equal(p.reportDate, "2026-06-23");
    assert.equal(p.quarter, "2026-06");
  });
});

describe("scale — the filings state ratios, not percents", () => {
  it("reads a 0.6397 fraction as 63.97 percent", () => {
    const p = parsed(BANKBARODA_XML);
    assert.equal(p.scale, "fraction");
    assert.equal(p.scaleSource, "grand-total");
    assert.equal(p.promoterPct, 63.97);
    // The bug this guards: 0.6397 written straight through.
    assert.notEqual(p.promoterPct, 0.6397);
  });

  it("rounds to the filings' own 4dp instead of leaking float noise", () => {
    // 0.6397 * 100 === 63.96999999999999 in IEEE-754.
    const p = parsed(BANKBARODA_XML);
    assert.equal(String(p.promoterPct), "63.97");
    assert.equal(String(p.mutualFundPct), "9.78");
  });

  it("accepts a filer that states percents, anchored on the grand total", () => {
    const p = parsed(
      synth({
        categories: [
          { member: "ShareholdingPatternMember", pct: "100", shares: "1000" },
          {
            member: "ShareholdingOfPromoterAndPromoterGroupMember",
            pct: "63.97",
            shares: "640",
          },
        ],
      }),
    );
    assert.equal(p.scale, "percent");
    assert.equal(p.scaleSource, "grand-total");
    assert.equal(p.promoterPct, 63.97);
  });

  it("falls back to the share ratio when the grand total states no percentage", () => {
    const p = parsed(
      synth({
        categories: [
          // Total has a share count but no percentage — no anchor to read.
          { member: "ShareholdingPatternMember", shares: "1000" },
          {
            member: "ShareholdingOfPromoterAndPromoterGroupMember",
            pct: "0.64",
            shares: "640",
          },
        ],
      }),
    );
    assert.equal(p.scale, "fraction");
    assert.equal(p.scaleSource, "share-ratio");
    assert.equal(p.promoterPct, 64);
  });

  it("refuses a document whose scale cannot be established", () => {
    const xml = synth({
      categories: [
        // A grand total that is neither 1 nor 100, and no share counts to
        // cross-check against. Guessing here is how 0.64 becomes 64.
        { member: "ShareholdingPatternMember", pct: "7" },
        { member: "ShareholdingOfPromoterAndPromoterGroupMember", pct: "4" },
      ],
    });
    assert.equal(parseShareholdingXbrl(xml), null);
    const o = inspectShareholdingXbrl(xml);
    assert.equal(o.kind, "scale-undeterminable");
  });
});

describe("promoter pledge — the element name says one thing and means another", () => {
  it("reports BEDMUTHA's pledge as 94.99% of the PROMOTER's holding", () => {
    const p = parsed(BEDMUTHA_XML);
    assert.equal(p.promoterPct, 57.09);
    assert.equal(p.promoterShares, 18_418_479n);
    assert.equal(p.totalShares, 32_263_884n);

    // 17,496,105 pledged shares. Of the promoter's own stake that is 94.99%;
    // of the whole company it is 54.23%. The filing states BOTH, under
    // different contexts, using the SAME element name. This is the promoter
    // one — the number every consumer means by "promoter pledge".
    assert.equal(p.promoterPledgedPct, 94.99);
    assert.notEqual(p.promoterPledgedPct, 54.23);

    // Cross-check the arithmetic so the assertion is not just a golden value.
    const pledgedShares = 17_496_105;
    assert.equal(
      Math.round((pledgedShares / Number(p.promoterShares)) * 1e4) / 1e2,
      94.99,
    );
    assert.equal(
      Math.round((pledgedShares / Number(p.totalShares)) * 1e4) / 1e2,
      54.23,
    );
  });

  it("leaves the pledge null when the promoter filed no encumbrance", () => {
    for (const xml of [BANKBARODA_XML, BHARTIARTL_XML]) {
      assert.equal(parsed(xml).promoterPledgedPct, null);
    }
  });
});

describe("diiPct is the FILED total, never a sum of the legs we model", () => {
  it("uses the filing's own DII total and records that it did", () => {
    const p = parsed(BANKBARODA_XML);
    assert.equal(p.diiMode, "filed");
    assert.equal(p.diiPct, 18.42);
  });

  it("proves the legs this schema models would UNDERSTATE that total", () => {
    const p = parsed(BANKBARODA_XML);
    const legs =
      (p.mutualFundPct ?? 0) +
      (p.insurancePct ?? 0) +
      (p.banksFiPct ?? 0) +
      (p.alternateInvPct ?? 0);
    // 9.78 + 5.93 + 0.06 + 0.24
    assert.equal(Math.round(legs * 100) / 100, 16.01);
    // The missing 2.41 points are provident/pension (2.32), domestic sovereign
    // wealth (0.08) and NBFCs — categories with no column in this schema. They
    // are still in `categories`, which is why `raw` keeps every member.
    assert.equal(p.categories.ProvidentFundsOrPensionFundsMember?.pct, 2.32);
    assert.equal(p.categories.SovereignWealthFundsDomesticMember?.pct, 0.08);
    assert.ok(
      (p.diiPct ?? 0) - legs > 2,
      "a derived DII total would understate this filing by >2 percentage points",
    );
  });

  it("sums the legs ONLY when the filing states no total, and says so", () => {
    const p = parsed(
      synth({
        categories: [
          { member: "ShareholdingPatternMember", pct: "1", shares: "1000" },
          {
            member: "ShareholdingOfPromoterAndPromoterGroupMember",
            pct: "0.5",
            shares: "500",
          },
          { member: "MutualFundsOrUTIMember", pct: "0.1", shares: "100" },
          { member: "InsuranceCompaniesMember", pct: "0.05", shares: "50" },
        ],
      }),
    );
    assert.equal(p.diiMode, "summed-legs");
    assert.equal(p.diiPct, 15);
    assert.equal(p.diiShares, 150n);
  });
});

describe("fiiPct is FPI Category I + Category II", () => {
  it("sums the two FPI categories and records the mode", () => {
    const p = parsed(BANKBARODA_XML);
    assert.equal(p.fiiMode, "fpi-categories");
    // Cat I 9.54 + Cat II 0.60.
    assert.equal(
      p.categories.InstitutionsForeignPortfolioInvestorCategoryOneMember?.pct,
      9.54,
    );
    assert.equal(
      p.categories.InstitutionsForeignPortfolioInvestorCategoryTwoMember?.pct,
      0.6,
    );
    assert.equal(p.fiiPct, 10.14);
  });

  it("excludes the overseas-depository and other-foreign legs from fiiShares", () => {
    const p = parsed(BANKBARODA_XML);
    // The filing's `InstitutionsForeignMember` total is 524,527,303 shares; it
    // also carries 110,000 overseas-depository (an ADR/GDR custodian pool) and
    // 14,000 other-foreign shares. Those are foreign institutions but they are
    // not portfolio investors, so they stay out of "FII".
    assert.equal(p.fiiShares, 524_403_303n);
    assert.equal(p.categories.InstitutionsForeignMember?.shares, "524527303");
    assert.equal(
      524_527_303n - (p.fiiShares ?? 0n),
      124_000n,
      "the excluded legs are exactly overseas depositories + other foreign",
    );
  });

  it("falls back to the foreign-institutions total when no FPI line is filed", () => {
    const p = parsed(
      synth({
        categories: [
          { member: "ShareholdingPatternMember", pct: "1", shares: "1000" },
          { member: "PublicShareholdingMember", pct: "1", shares: "1000" },
          { member: "InstitutionsForeignMember", pct: "0.2", shares: "200" },
        ],
      }),
    );
    assert.equal(p.fiiMode, "foreign-institutions-total");
    assert.equal(p.fiiPct, 20);
    assert.equal(p.fiiShares, 200n);
  });
});

describe("absence is null and is NEVER zero", () => {
  it("leaves promoterPct null for a company with no promoter table", () => {
    const p = parsed(CUB_XML);
    // NSE's summary says `0` for the same quarter. "Filed as zero" and "no
    // promoter row exists" are different facts and only one of them is a
    // number we read.
    assert.equal(p.promoterPct, null);
    assert.notEqual(p.promoterPct, 0);
    assert.equal(p.promoterShares, null);
    assert.equal(p.memberHits.promoter, undefined);
  });

  it("leaves BOTH institutional totals null for a smallcap with no institutions", () => {
    const p = parsed(BEDMUTHA_XML);
    assert.equal(p.fiiPct, null);
    assert.equal(p.diiPct, null);
    assert.equal(p.fiiShares, null);
    assert.equal(p.diiShares, null);
    // No total was available AND no leg was either, so no mode was taken —
    // rather than a mode taken over an empty set, which would render as 0.
    assert.equal(p.fiiMode, null);
    assert.equal(p.diiMode, null);
    assert.equal(p.mutualFundPct, null);
    assert.equal(p.insurancePct, null);
    assert.equal(p.banksFiPct, null);
  });

  it("leaves the Table IV total null when the filing gives it shares but no percentage", () => {
    const p = parsed(BHARTIARTL_XML);
    // BHARTIARTL's `SharesHeldByNonPromoterNonPublicShareholdersMember` carries
    // 2,422,406 shares and NO percentage element at all.
    assert.equal(p.nonPromoterNonPublicPct, null);
    assert.equal(
      p.categories.SharesHeldByNonPromoterNonPublicShareholdersMember?.shares,
      "2422406",
    );
    // …while its only leg does have one.
    assert.equal(p.employeeTrustPct, 0.04);
  });

  it("keeps a FILED zero as 0, which is a different fact from absence", () => {
    const p = parsed(BANKBARODA_XML);
    // 37,946 government-held shares out of 5.17bn rounds to 0.0000.
    assert.equal(p.govtPct, 0);
    assert.equal(p.categories.GovernmentsMember?.shares, "37946");
    // And the promoter-table government member is NOT this one: Bank of
    // Baroda's 63.97% promoter is the Government of India, filed under
    // `CentralGovernmentOrStateGovernmentSMember` in Table II.
    assert.equal(
      p.categories.CentralGovernmentOrStateGovernmentSMember?.pct,
      63.97,
    );
    assert.equal(p.memberHits.governments, "GovernmentsMember");
  });

  it("turns a blank or dash cell into null, never 0", () => {
    for (const blank of ["", "   ", "-", "--", "NA", "N.A.", "NIL", "\n"]) {
      const p = parsed(
        synth({
          categories: [
            { member: "ShareholdingPatternMember", pct: "1", shares: "1000" },
            {
              member: "ShareholdingOfPromoterAndPromoterGroupMember",
              pct: "0.6",
              shares: "600",
            },
            { member: "MutualFundsOrUTIMember", pct: blank, shares: blank },
          ],
        }),
      );
      assert.equal(
        p.mutualFundPct,
        null,
        `blank ${JSON.stringify(blank)} must read as null`,
      );
      assert.notEqual(
        p.mutualFundPct,
        0,
        `blank ${JSON.stringify(blank)} must not coerce to 0`,
      );
      assert.equal(p.categories.MutualFundsOrUTIMember?.pct, null);
      assert.equal(p.categories.MutualFundsOrUTIMember?.shares, null);
    }
  });

  it("refuses a non-numeric or negative cell rather than coercing it", () => {
    const p = parsed(
      synth({
        categories: [
          { member: "ShareholdingPatternMember", pct: "1", shares: "1000" },
          {
            member: "ShareholdingOfPromoterAndPromoterGroupMember",
            pct: "0.6",
            shares: "600",
          },
          { member: "MutualFundsOrUTIMember", pct: "1.5%", shares: "-100" },
          { member: "InsuranceCompaniesMember", pct: "2.4", shares: "12.5" },
        ],
      }),
    );
    assert.equal(p.mutualFundPct, null); // "1.5%" is not a number
    assert.equal(p.categories.MutualFundsOrUTIMember?.shares, "-100");
    assert.equal(p.insurancePct, null); // 240% is out of range, not clamped
    assert.ok((p.reasons.pctOutOfRange ?? 0) >= 1);
    // A fractional share count is not a share count.
    assert.equal(p.diiShares, null);
  });
});

describe("refusal — an unrecognised shape returns null, not {}", () => {
  it("returns null (not an empty object) for NSE's missing-document page", () => {
    const r = parseShareholdingXbrl(NOT_FOUND_HTML);
    assert.equal(r, null);
    // The mutation this pins: returning `{}` would make `r !== null` true and
    // hand the caller an object to checkpoint on.
    assert.notDeepEqual(r, {});
    assert.equal(inspectShareholdingXbrl(NOT_FOUND_HTML).kind, "not-xml");
  });

  it("returns null for empty and whitespace input", () => {
    for (const input of ["", "   \n\t "]) {
      assert.equal(parseShareholdingXbrl(input), null);
      assert.equal(inspectShareholdingXbrl(input).kind, "empty-input");
    }
  });

  it("returns null for a well-formed XBRL in another taxonomy", () => {
    // The results taxonomy — same host, same directory, different schema.
    const other = synth({
      namespace: "http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin",
      categories: [
        { member: "ShareholdingPatternMember", pct: "1", shares: "1000" },
      ],
    });
    assert.equal(parseShareholdingXbrl(other), null);
    const o = inspectShareholdingXbrl(other);
    assert.equal(o.kind, "unknown-taxonomy");
    assert.ok(
      o.kind === "unknown-taxonomy" &&
        o.namespaces.some((n) => n.includes("in-bse-fin")),
      "the refusal reports what it saw instead so a taxonomy shift is visible",
    );
  });

  it("does not bind the prefix of the sibling -types schema", () => {
    // Both `…/in-bse-shp` and `…/in-bse-shp-types` are declared on every real
    // filing. An unanchored namespace match binds whichever comes first, finds
    // zero facts under it, and reports a healthy filing as unreadable.
    const p = parsed(BANKBARODA_XML);
    assert.equal(p.taxonomyVersion, "2025-10-31");
    assert.ok(Object.keys(p.categories).length > 20);
  });

  it("returns null for an SHP document with no category at all", () => {
    const xml = synth({ categories: [] });
    assert.equal(parseShareholdingXbrl(xml), null);
    assert.equal(inspectShareholdingXbrl(xml).kind, "no-categories");
  });

  it("returns null when nothing anchors the document to a company", () => {
    // A readable scale but no promoter, no public and no total share count:
    // whatever this describes, it is not a company's shareholding.
    const xml = synth({
      categories: [
        { member: "ShareholdingPatternMember", pct: "1" },
        { member: "MutualFundsOrUTIMember", pct: "0.1" },
      ],
    });
    assert.equal(parseShareholdingXbrl(xml), null);
    assert.equal(inspectShareholdingXbrl(xml).kind, "no-anchor");
  });
});

describe("counts are BigInt, and `categories` stays serialisable", () => {
  it("reads a share count beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const huge = "9007199254740993"; // 2^53 + 1 — unrepresentable as a Number
    const p = parsed(
      synth({
        categories: [
          { member: "ShareholdingPatternMember", pct: "1", shares: huge },
          {
            member: "ShareholdingOfPromoterAndPromoterGroupMember",
            pct: "0.5",
            shares: huge,
          },
        ],
      }),
    );
    assert.equal(p.totalShares, 9_007_199_254_740_993n);
    assert.notEqual(Number(p.totalShares), Number.MAX_SAFE_INTEGER);
    assert.equal(String(p.totalShares), huge);
  });

  it("JSON.stringify's the categories record — `raw` depends on it", () => {
    const p = parsed(BANKBARODA_XML);
    // BigInt throws in JSON.stringify, so share counts are kept verbatim as
    // strings in `categories`. A `raw` that cannot be serialised is not an
    // audit artifact.
    const json = JSON.stringify(p.categories);
    assert.ok(json.length > 100);
    const back = JSON.parse(json) as Record<string, { shares: string | null }>;
    assert.equal(back.ShareholdingPatternMember?.shares, "5171362179");
  });

  it("keeps members this schema has no column for", () => {
    const p = parsed(BANKBARODA_XML);
    for (const member of [
      "ProvidentFundsOrPensionFundsMember",
      "NBFCsRegisteredWithRBIMember",
      "NonResidentIndiansMember",
      "InvestorEducationAndProtectionFundMember",
    ]) {
      assert.ok(member in p.categories, `${member} must survive into raw`);
    }
  });
});

describe("reason tallies separate the benign case from the harmful one", () => {
  it("counts per-shareholder detail rows without hiding a real attribution loss", () => {
    for (const xml of [BANKBARODA_XML, CUB_XML, BHARTIARTL_XML, BEDMUTHA_XML]) {
      const p = parsed(xml);
      // The >1% holder rows and per-holder pledge splits live in declared but
      // category-less contexts. Dozens of them on every healthy filing.
      assert.ok((p.reasons.nonCategoryContext ?? 0) > 0);
      // A contextRef pointing at nothing is invalid XBRL and real data loss.
      // Zero on all four — so a rise is visible instead of buried.
      assert.equal(p.reasons.undeclaredContext, undefined);
    }
  });

  it("records which candidate member actually matched", () => {
    const p = parsed(BANKBARODA_XML);
    assert.equal(
      p.memberHits.promoter,
      "ShareholdingOfPromoterAndPromoterGroupMember",
    );
    assert.equal(p.memberHits.grandTotal, "ShareholdingPatternMember");
    assert.equal(
      p.memberHits.fpiCategoryOne,
      "InstitutionsForeignPortfolioInvestorCategoryOneMember",
    );
    // Custodian/DR is a GUESS — no candidate has ever matched a live filing, so
    // it must be absent here rather than quietly "working".
    assert.equal(p.memberHits.custodianDr, undefined);
    assert.equal(p.custodianDrPct, null);
  });
});

describe("reconcileWithSummary — refuse a document that belongs elsewhere", () => {
  const bankbaroda = () => parsed(BANKBARODA_XML);

  it("agrees with the summary row it was linked from", () => {
    const v = reconcileWithSummary(bankbaroda(), {
      symbol: "BANKBARODA",
      quarter: "2026-06",
      promoterPct: 63.97,
      publicPct: 36.03,
    });
    assert.equal(v.status, "agree");
    assert.ok(v.status === "agree" && v.checked.length === 2);
    assert.ok(v.status === "agree" && v.maxDeltaPct < RECONCILE_TOLERANCE_PCT);
  });

  it("catches a document that belongs to a DIFFERENT company", () => {
    const v = reconcileWithSummary(bankbaroda(), {
      symbol: "BHARTIARTL",
      quarter: "2026-06",
      promoterPct: 50.07,
      publicPct: 49.89,
    });
    assert.equal(v.status, "disagree");
    assert.ok(v.status === "disagree" && v.field === "symbol");
  });

  it("catches a mismatched company even when the symbols are absent", () => {
    // Symbol stripped from both sides: the percentages still cannot be BoB's.
    const b = { ...bankbaroda(), symbol: null };
    const v = reconcileWithSummary(b, {
      symbol: "",
      quarter: "2026-06",
      promoterPct: 50.07,
      publicPct: 49.89,
    });
    assert.equal(v.status, "disagree");
    assert.ok(v.status === "disagree" && v.field === "promoterPct");
    assert.ok(v.status === "disagree" && (v.deltaPct ?? 0) > 13);
  });

  it("catches a document for a different QUARTER", () => {
    const v = reconcileWithSummary(bankbaroda(), {
      symbol: "BANKBARODA",
      quarter: "2026-03",
      promoterPct: 63.97,
      publicPct: 36.03,
    });
    assert.equal(v.status, "disagree");
    assert.ok(v.status === "disagree" && v.field === "quarter");
  });

  it("treats null-vs-zero as INCOMPARABLE, not as a 100-point delta", () => {
    // CUB: the filing has no promoter row; the summary says `0`. Neither
    // "they agree" nor "they conflict" is true, and public 100 vs 100 is what
    // actually gets verified.
    const v = reconcileWithSummary(parsed(CUB_XML), {
      symbol: "CUB",
      quarter: "2026-06",
      promoterPct: 0,
      publicPct: 100,
    });
    assert.equal(v.status, "agree");
    assert.deepEqual(v.status === "agree" ? v.checked : null, ["publicPct"]);
  });

  it("reports incomparable when nothing on either side lines up", () => {
    const v = reconcileWithSummary(parsed(CUB_XML), {
      symbol: "CUB",
      quarter: "2026-06",
      promoterPct: null,
      publicPct: null,
    });
    assert.equal(v.status, "incomparable");
    assert.ok(v.status === "incomparable" && v.reason === "noComparableValue");
  });

  it("surfaces an ISIN mismatch WITHOUT failing on it", () => {
    // Measured on prod: NSE's summary says IN9028A01011 for BANKBARODA while
    // NSE's own filing says INE028A01039 — 2 of 5 sampled symbols disagree
    // this way. Failing on ISIN would reject 40% of a healthy sample.
    const v = reconcileWithSummary(bankbaroda(), {
      symbol: "BANKBARODA",
      quarter: "2026-06",
      promoterPct: 63.97,
      publicPct: 36.03,
      isin: "IN9028A01011",
    });
    assert.equal(v.status, "agree");
    assert.ok(v.status === "agree" && v.isinMismatch === true);
  });

  it("tolerates the summary's 2dp rounding but not a real difference", () => {
    const near = reconcileWithSummary(bankbaroda(), {
      symbol: "BANKBARODA",
      quarter: "2026-06",
      promoterPct: 63.98,
      publicPct: 36.02,
    });
    assert.equal(near.status, "agree");

    const far = reconcileWithSummary(bankbaroda(), {
      symbol: "BANKBARODA",
      quarter: "2026-06",
      promoterPct: 62.9,
      publicPct: 36.03,
    });
    assert.equal(far.status, "disagree");
    assert.ok(far.status === "disagree" && far.field === "promoterPct");
  });

  it("matches symbols case-insensitively and ignores an exchange suffix", () => {
    const v = reconcileWithSummary(bankbaroda(), {
      symbol: "bankbaroda.ns",
      quarter: "2026-06",
      promoterPct: 63.97,
      publicPct: 36.03,
    });
    assert.equal(v.status, "agree");
  });
});
