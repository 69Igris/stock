/**
 * UNIT TEST — NSE corporate-results XBRL parser (MONEY-1113, XBRL F1).
 *
 * ## SCOPE — this file covers the LEGACY `in-bse-fin` taxonomy only
 *
 * All three fixtures here predate SEBI's integrated-filing regime. That was not
 * obvious when they were chosen, and it cost months: every CURRENT filing is
 * served in the `in-capmkt` taxonomy instead, the parser understood none of
 * them, and THIS FILE STAYED GREEN throughout (MONEY-1200). The integrated era
 * — namespace dispatch, the four entry points, governance filings — is covered
 * by its sibling `xbrl-integrated-taxonomy.test.ts`. Neither file is the whole
 * picture; a change to the parser needs both.
 *
 * ## The fixtures are real filings, fetched 2026-08-14
 *
 * Discovered through
 * `GET nseindia.com/api/corporates-financial-results?index=equities&period=Quarterly&from_date=…&to_date=…`
 * and downloaded cookieless from `nsearchives.nseindia.com/corporate/xbrl/…`.
 * Three taxonomy versions and both legacy statement families on purpose:
 *
 * | fixture      | symbol     | period          | family  | basis        | taxonomy   |
 * |--------------|------------|-----------------|---------|--------------|------------|
 * | glaxo…       | GLAXO      | Q2 FY25         | ind-as  | standalone   | 2020-03-31 |
 * | icicibank…   | ICICIBANK  | Q2 FY25         | banking | standalone   | 2019-09-30 |
 * | bhartiartl…  | BHARTIARTL | Q2 FY20         | ind-as  | consolidated | 2018-03-31 |
 *
 * `nse-missing-xbrl-404.html` is the body NSE actually serves for
 * `…/corporate/xbrl/-`, the well-formed-but-empty URL its metadata emits for
 * filings that have no XBRL. It starts with `http`, so a `startsWith("http")`
 * validity check passes it; only `.endsWith(".xml")` — or parsing it, which is
 * what this file asserts — catches it.
 *
 * ## Values are checked against the published results, not against this parser
 *
 * GSK Pharma Q2-FY25 revenue ₹1,000.05 Cr / PAT ₹248.69 Cr / EPS 14.45.
 * ICICI Bank Q2-FY25 standalone interest earned ₹40,537.38 Cr / PAT ₹11,745.88
 * Cr / GNPA 1.97%. Bharti Airtel Q2-FY20 consolidated revenue ₹21,131.3 Cr with
 * the ₹30,711 Cr AGR exceptional item and a ₹23,044.9 Cr loss to owners. Those
 * are the numbers asserted below, so a wrong-context regression shows up as a
 * wrong REAL number rather than as a diff against a golden blob.
 *
 * ## The load-bearing case
 *
 * `picks the quarter, never the year-to-date sharing its end date`. Both
 * contexts declare the SAME `<xbrli:period>`; only the in-context
 * `DateOfStartOfReportingPeriod` fact separates them. Get it wrong on GLAXO and
 * you report ₹1,811.05 Cr of half-year revenue as a quarter — an 81%
 * overstatement that nothing downstream can contradict.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseXbrlFinancials,
  resolveConceptTable,
  type XbrlFinancials,
} from "../../src/market-data/xbrl-financials-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl");
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const GLAXO_XML = read("glaxo-q2fy25-standalone-indas-2020-03-31.xml");
const ICICI_XML = read("icicibank-q2fy25-standalone-banking-2019-09-30.xml");
const BHARTI_XML = read("bhartiartl-q2fy20-consolidated-indas-2018-03-31.xml");
const NOT_FOUND_HTML = read("nse-missing-xbrl-404.html");

/** Parse-or-fail, so a `null` regression fails on the assertion, not a TypeError. */
function parsed(xml: string): XbrlFinancials {
  const r = parseXbrlFinancials(xml);
  assert.ok(r !== null, "expected the document to parse");
  return r;
}

/* -------------------------------------------------------------------------- */
/* Synthetic instances — for shapes the real fixtures do not contain           */
/* -------------------------------------------------------------------------- */

interface SynthContext {
  id: string;
  start?: string;
  end?: string;
  instant?: string;
  dimension?: string;
}

interface SynthFact {
  tag: string;
  context: string;
  value: string;
  /** Emit as `<tag … />` — an XBRL nil, which must not read as 0. */
  nil?: boolean;
}

/**
 * A minimal but structurally faithful instance. Used only for shapes the three
 * real filings do not exhibit — a true prior-year comparative, a missing
 * reporting-period fact, nil facts — so the real fixtures stay untouched.
 */
function synth(opts: {
  version?: string;
  taxPrefix?: string;
  schemaRef?: string;
  contexts: SynthContext[];
  facts: SynthFact[];
}): string {
  const ver = opts.version ?? "2020-03-31";
  const pfx = opts.taxPrefix ?? "in-bse-fin";
  const ns = `http://www.bseindia.com/xbrl/fin/${ver}/in-bse-fin`;

  const contexts = opts.contexts
    .map((c) => {
      const period =
        c.instant !== undefined
          ? `<xbrli:instant>${c.instant}</xbrli:instant>`
          : `<xbrli:startDate>${c.start}</xbrli:startDate><xbrli:endDate>${c.end}</xbrli:endDate>`;
      const scenario =
        c.dimension === undefined
          ? ""
          : `<xbrli:scenario><xbrldi:explicitMember dimension="${pfx}:${c.dimension}">${pfx}:AMember</xbrldi:explicitMember></xbrli:scenario>`;
      return `<xbrli:context id="${c.id}"><xbrli:entity><xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">TESTCO</xbrli:identifier></xbrli:entity><xbrli:period>${period}</xbrli:period>${scenario}</xbrli:context>`;
    })
    .join("\n");

  const facts = opts.facts
    .map((f) =>
      f.nil === true
        ? `<${pfx}:${f.tag} contextRef="${f.context}" xsi:nil="true"/>`
        : `<${pfx}:${f.tag} contextRef="${f.context}" unitRef="INR" decimals="-6">${f.value}</${pfx}:${f.tag}>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:${pfx}="${ns}" xmlns:${pfx}-roles="http://www.bseindia.com/xbrl/fin/${ver}/in-bse-fin-roles" xmlns:${pfx}-type="http://www.bseindia.com/xbrl/fin/${ver}/in-bse-fin-types" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<link:schemaRef xlink:type="simple" xlink:href="${opts.schemaRef ?? `Ind-AS_entry_point_${ver}.xsd`}"/>
${contexts}
<xbrli:unit id="INR"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>
${facts}
</xbrli:xbrl>`;
}

/** The four facts a context needs to become a resolvable reporting period. */
const periodFacts = (ctx: string, start: string, end: string): SynthFact[] => [
  { tag: "DateOfStartOfReportingPeriod", context: ctx, value: start },
  { tag: "DateOfEndOfReportingPeriod", context: ctx, value: end },
];

/* -------------------------------------------------------------------------- */

describe("parseXbrlFinancials — GLAXO Q2 FY25 (ind-as, standalone, 2020-03-31)", () => {
  const r = parsed(GLAXO_XML);

  it("discovers the taxonomy version rather than assuming one", () => {
    assert.equal(r.taxonomy.version, "2020-03-31");
    assert.equal(r.taxonomy.prefix, "in-bse-fin");
    assert.equal(
      r.taxonomy.namespace,
      "http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin",
    );
  });

  it("reads identity and filing metadata", () => {
    assert.equal(r.family, "ind-as");
    assert.equal(r.symbol, "GLAXO");
    assert.equal(r.companyName, "GlaxoSmithKline Pharmaceuticals Limited");
    assert.equal(r.basis, "standalone");
    assert.equal(r.audited, false);
    assert.equal(r.currency, "INR");
  });

  it("has no ISIN — the Ind-AS entry point does not carry one", () => {
    assert.equal(r.isin, null);
  });

  it("reports the rounding LABEL without rescaling the values", () => {
    // "Lakhs" describes the printed statement. The XBRL number is absolute
    // rupees: ₹10,000,500,000 = ₹1,000.05 Cr, GSK's published Q2-FY25 revenue.
    assert.equal(r.roundingLabel, "Lakhs");
    assert.equal(r.values.revenueFromOperations, 10_000_500_000);
  });

  it("resolves the quarter as the reporting period", () => {
    assert.deepEqual(
      { start: r.period.start, end: r.period.end, days: r.period.days },
      { start: "2024-07-01", end: "2024-09-30", days: 91 },
    );
    assert.equal(r.period.contextRef, "OneD");
    assert.equal(r.period.source, "reported-facts");
  });

  it("extracts the income statement core", () => {
    assert.equal(r.values.revenueFromOperations, 10_000_500_000);
    assert.equal(r.values.otherIncome, 321_900_000);
    assert.equal(r.values.totalIncome, 10_322_400_000);
    assert.equal(r.values.totalExpenses, 6_982_300_000);
    assert.equal(r.values.profitBeforeTax, 3_387_000_000);
    assert.equal(r.values.taxExpense, 900_100_000);
    assert.equal(r.values.profitFromContinuingOperations, 2_486_900_000);
    assert.equal(r.values.profitForPeriod, 2_486_900_000);
  });

  it("extracts the discontinued-operations variants", () => {
    assert.equal(r.values.profitFromDiscontinuedOperationsBeforeTax, 0);
    assert.equal(r.values.profitFromDiscontinuedOperationsAfterTax, 0);
  });

  it("extracts EPS", () => {
    assert.equal(r.values.basicEps, 14.45);
    assert.equal(r.values.dilutedEps, 14.68);
    assert.equal(r.values.faceValuePerShare, 10);
  });

  it("extracts the balance sheet from the matching column instant", () => {
    assert.equal(r.balanceSheetDate, "2024-09-30");
    assert.equal(r.balanceSheetSource, "column");
    assert.equal(r.values.totalAssets, 37_300_900_000);
    assert.equal(r.values.totalEquity, 16_746_600_000);
    assert.equal(r.values.totalLiabilities, 20_554_300_000);
    assert.equal(r.values.inventories, 5_004_700_000);
    assert.equal(r.values.cashAndCashEquivalents, 384_900_000);
  });

  it("reports full coverage with nothing missing", () => {
    assert.equal(r.coverage.level, "full");
    assert.deepEqual(r.coverage.missing, []);
    assert.equal(r.coverage.byGroup.balanceSheet.present, 15);
    assert.equal(r.coverage.byGroup.balanceSheet.expected, 15);
  });
});

describe("parseXbrlFinancials — ICICIBANK Q2 FY25 (banking, 2019-09-30)", () => {
  const r = parsed(ICICI_XML);

  it("detects the banking family from the RBI entry point", () => {
    assert.equal(r.family, "banking");
    assert.equal(r.taxonomy.version, "2019-09-30");
  });

  it("reads the bank-specific name and the ISIN this family carries", () => {
    // `NameOfBank`, not `NameOfTheCompany` — a filer-type tag rename.
    assert.equal(r.companyName, "ICICI Bank Limited");
    assert.equal(r.isin, "INE090A01021");
    assert.equal(r.symbol, "ICICIBANK");
  });

  it("maps InterestEarned onto the canonical top line", () => {
    // ₹40,537.38 Cr, ICICI's published Q2-FY25 standalone interest earned.
    assert.equal(r.values.revenueFromOperations, 405_373_800_000);
    assert.equal(r.values.otherIncome, 71_766_600_000);
    assert.equal(r.values.totalIncome, 477_140_400_000);
  });

  it("maps the bank spellings of the shared income-statement concepts", () => {
    // InterestExpended → financeCosts, EmployeesCost → employeeBenefitExpense,
    // ExpenditureExcludingProvisionsAndContingencies → totalExpenses,
    // ProfitLossFromOrdinaryActivitiesBeforeTax → profitBeforeTax.
    assert.equal(r.values.financeCosts, 204_894_000_000);
    assert.equal(r.values.employeeBenefitExpense, 41_361_400_000);
    assert.equal(r.values.totalExpenses, 309_908_600_000);
    assert.equal(r.values.profitBeforeTax, 154_900_900_000);
    // `ProfitLossForThePeriod` — the banking taxonomy inserts a "The".
    assert.equal(r.values.profitForPeriod, 117_458_800_000);
  });

  it("extracts the banking-only concepts", () => {
    assert.equal(r.values.operatingProfitBeforeProvisions, 167_231_800_000);
    assert.equal(r.values.provisionsOtherThanTax, 12_330_900_000);
    assert.equal(r.values.grossNpa, 271_211_500_000);
    assert.equal(r.values.grossNpaRatio, 0.0197);
    assert.equal(r.values.netNpaRatio, 0.0042);
    assert.equal(r.values.cet1Ratio, 0.1465);
  });

  it("extracts the RBI Form-A balance sheet", () => {
    assert.equal(r.balanceSheetSource, "column");
    assert.equal(r.balanceSheetDate, "2024-09-30");
    assert.equal(r.values.totalAssets, 19_768_582_300_000);
    assert.equal(r.values.deposits, 14_977_606_700_000);
    assert.equal(r.values.advances, 12_772_404_300_000);
    assert.equal(r.values.bankCapital, 30_601_900_000);
    assert.equal(r.values.bankReservesAndSurplus, 2_564_798_000_000);
  });

  it("leaves Ind-AS-only concepts absent and does NOT list them missing", () => {
    // A bank has no `Equity` total (it is Capital + ReservesAndSurplus) and no
    // inventories. Summing them here would be derivation, not parsing; listing
    // them as missing would turn `missing` into a list of things that are fine.
    assert.equal(r.values.totalEquity, undefined);
    assert.equal(r.values.inventories, undefined);
    assert.ok(!r.coverage.missing.includes("totalEquity"));
    assert.ok(!r.coverage.missing.includes("inventories"));
    assert.deepEqual(r.coverage.missing, []);
    assert.equal(r.coverage.level, "full");
  });

  it("uses the quarter column, not the half-year", () => {
    assert.equal(r.period.start, "2024-07-01");
    assert.deepEqual(
      r.otherPeriods.map((p) => p.start),
      ["2024-04-01"],
    );
  });
});

describe("parseXbrlFinancials — BHARTIARTL Q2 FY20 (consolidated, 2018-03-31)", () => {
  const r = parsed(BHARTI_XML);

  it("parses the oldest taxonomy version in the set", () => {
    assert.equal(r.taxonomy.version, "2018-03-31");
    assert.equal(r.family, "ind-as");
  });

  it("survives contexts that the document never declares", () => {
    // This `_WEB.xml` references contextRef="OneD"/"FourD" from 106 facts and
    // declares NEITHER context. It is invalid XBRL. A conforming parser drops
    // the whole primary income statement and reports nothing.
    assert.ok(!BHARTI_XML.includes('id="OneD"'));
    assert.ok(BHARTI_XML.includes('contextRef="OneD"'));
    assert.equal(r.period.contextRef, "OneD");
    assert.equal(r.period.source, "reported-facts");
    assert.equal(r.values.revenueFromOperations, 211_313_000_000);
  });

  it("reads the consolidated flag", () => {
    assert.equal(r.basis, "consolidated");
    assert.equal(r.audited, true);
  });

  it("falls back to the entity identifier when no name tag exists", () => {
    // The 2018-03-31 files carry neither NameOfTheCompany nor NameOfBank nor
    // ISIN — only the context entity identifier.
    assert.equal(r.companyName, null);
    assert.equal(r.isin, null);
    assert.equal(r.symbol, "BHARTIARTL");
  });

  it("carries negative values through unchanged", () => {
    // The AGR quarter: a ₹30,711 Cr exceptional charge and a ₹23,044.9 Cr loss
    // attributable to owners. Anything that clamps or abs()es shows up here.
    assert.equal(r.values.exceptionalItems, -307_110_000_000);
    assert.equal(r.values.profitBeforeTax, -316_495_000_000);
    assert.equal(r.values.profitForPeriod, -228_301_000_000);
    assert.equal(r.values.profitAttributableToOwners, -230_449_000_000);
    assert.equal(r.values.basicEps, -44.92);
  });

  it("extracts the consolidation-only concepts", () => {
    assert.equal(
      r.values.profitAttributableToNonControllingInterests,
      2_148_000_000,
    );
    assert.equal(r.values.shareOfProfitOfAssociates, 3_155_000_000);
  });

  it("reports the absent balance sheet as absent, not as zeroes", () => {
    assert.equal(r.balanceSheetDate, null);
    assert.equal(r.balanceSheetSource, null);
    assert.equal(r.values.totalAssets, undefined);
    assert.equal(r.coverage.level, "income");
    assert.equal(r.coverage.byGroup.balanceSheet.present, 0);
    assert.equal(r.coverage.byGroup.balanceSheet.expected, 15);
    assert.ok(r.coverage.missing.includes("totalAssets"));
    assert.ok(r.coverage.missing.includes("totalEquity"));
  });
});

/* -------------------------------------------------------------------------- */
/* REGRESSION — context resolution                                            */
/* -------------------------------------------------------------------------- */

describe("REGRESSION: context resolution never returns a comparative as current", () => {
  it("picks the quarter, never the year-to-date sharing its end date", () => {
    // Both GLAXO contexts declare <xbrli:period> 2024-07-01..2024-09-30. Only
    // the in-context DateOfStartOfReportingPeriod fact says FourD is the H1
    // column. Picking FourD reports ₹1,811.05 Cr as a quarter's revenue.
    const r = parsed(GLAXO_XML);
    assert.equal(r.values.revenueFromOperations, 10_000_500_000);
    assert.notEqual(r.values.revenueFromOperations, 18_110_500_000);
    assert.equal(r.values.profitForPeriod, 2_486_900_000);
    assert.notEqual(r.values.profitForPeriod, 4_303_400_000);

    // The YTD column is not discarded — it is reported, clearly labelled.
    assert.deepEqual(
      r.otherPeriods.map((p) => `${p.contextRef}:${p.start}..${p.end}`),
      ["FourD:2024-04-01..2024-09-30"],
    );
  });

  it("the <xbrli:period> declarations really are identical in the fixture", () => {
    // Guards the premise. If NSE ever fixes its writer this assertion fails
    // and tells us the fallback path stopped being load-bearing.
    const ctx = (id: string): string => {
      const m = new RegExp(
        `<xbrli:context id="${id}">[\\s\\S]*?</xbrli:context>`,
      ).exec(GLAXO_XML);
      assert.ok(m !== null);
      return m[0];
    };
    const period = (s: string): string => {
      const inner = /<xbrli:period>([\s\S]*?)<\/xbrli:period>/.exec(s)?.[1];
      assert.ok(inner !== undefined);
      return inner;
    };
    assert.equal(period(ctx("OneD")), period(ctx("FourD")));
  });

  it("is not relying on document order — the YTD may come first", () => {
    const xml = synth({
      contexts: [
        { id: "FourD", start: "2025-07-01", end: "2025-09-30" },
        { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
      ],
      facts: [
        ...periodFacts("FourD", "2025-04-01", "2025-09-30"),
        { tag: "RevenueFromOperations", context: "FourD", value: "2000" },
        ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
        { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
      ],
    });
    const r = parsed(xml);
    assert.equal(r.period.contextRef, "OneD");
    assert.equal(r.values.revenueFromOperations, 1000);
  });

  it("never picks a PRIOR-YEAR comparative over the current quarter", () => {
    const xml = synth({
      contexts: [
        { id: "ThreeD", start: "2024-07-01", end: "2024-09-30" },
        { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
      ],
      facts: [
        ...periodFacts("ThreeD", "2024-07-01", "2024-09-30"),
        { tag: "RevenueFromOperations", context: "ThreeD", value: "900" },
        ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
        { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
      ],
    });
    const r = parsed(xml);
    assert.equal(r.period.end, "2025-09-30");
    assert.equal(r.values.revenueFromOperations, 1000);
    assert.deepEqual(
      r.otherPeriods.map((p) => p.end),
      ["2024-09-30"],
    );
  });

  it("ignores dimensioned contexts — a segment is not a column", () => {
    const xml = synth({
      contexts: [
        {
          id: "OneReportableSegmentRevenue01D",
          start: "2025-07-01",
          end: "2025-09-30",
          dimension: "ReportableSegmentsAxis",
        },
        { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
      ],
      facts: [
        // A segment context that (impossibly) declares a period must still lose.
        ...periodFacts(
          "OneReportableSegmentRevenue01D",
          "2025-07-01",
          "2025-09-30",
        ),
        {
          tag: "RevenueFromOperations",
          context: "OneReportableSegmentRevenue01D",
          value: "250",
        },
        ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
        { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
      ],
    });
    const r = parsed(xml);
    assert.equal(r.period.contextRef, "OneD");
    assert.equal(r.values.revenueFromOperations, 1000);
  });

  it("flags the weaker path when no reporting-period fact exists", () => {
    // Without the facts there is genuinely nothing separating the two columns.
    // The parser falls back to document order and SAYS so, rather than
    // presenting a coin flip as fact.
    const xml = synth({
      contexts: [
        { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
        { id: "FourD", start: "2025-07-01", end: "2025-09-30" },
      ],
      facts: [
        { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
        { tag: "RevenueFromOperations", context: "FourD", value: "2000" },
      ],
    });
    const r = parsed(xml);
    assert.equal(r.period.source, "context-period");
    assert.equal(r.period.contextRef, "OneD");
    assert.equal(r.values.revenueFromOperations, 1000);
  });

  it("matches the balance sheet by column, not by the shared instant date", () => {
    // ICICI's OneI and FourI are BOTH @2024-09-30, so the date cannot separate
    // them. Here the wrong column would yield 999.
    const xml = synth({
      contexts: [
        { id: "FourI", instant: "2025-09-30" },
        { id: "OneI", instant: "2025-09-30" },
        { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
      ],
      facts: [
        { tag: "Assets", context: "FourI", value: "999" },
        { tag: "Assets", context: "OneI", value: "5000" },
        ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
        { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
      ],
    });
    const r = parsed(xml);
    assert.equal(r.balanceSheetSource, "column");
    assert.equal(r.values.totalAssets, 5000);
  });

  it("both fixture instants really do share one date", () => {
    // Guards the premise of the test above against the real bytes.
    const instants = [
      ...ICICI_XML.matchAll(
        /<xbrli:context id="(One|Four)I">[\s\S]*?<xbrli:instant>([^<]*)</g,
      ),
    ].map((m) => m[2]);
    assert.deepEqual(instants, ["2024-09-30", "2024-09-30"]);
  });
});

/* -------------------------------------------------------------------------- */
/* REGRESSION — failure is null, never a hollow object                        */
/* -------------------------------------------------------------------------- */

describe("REGRESSION: unparseable input returns null, never {}", () => {
  const rejects: ReadonlyArray<[string, string]> = [
    ["empty string", ""],
    ["plain text", "not xml at all"],
    ["truncated mid-declaration", GLAXO_XML.slice(0, 120)],
    [
      "NSE's 404 body for the `/-` stub URL",
      // The metadata emits `…/corporate/xbrl/-` for filings with no XBRL. It
      // starts with "http", so a startsWith("http") check passes it.
      NOT_FOUND_HTML,
    ],
    [
      "well-formed XML that is not this taxonomy",
      '<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2024"><us-gaap:Revenues contextRef="C1">5</us-gaap:Revenues></xbrli:xbrl>',
    ],
    [
      "the taxonomy namespace without an XBRL instance root",
      '<?xml version="1.0"?><schema xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin" xmlns:xbrli="http://www.xbrl.org/2003/instance"/>',
    ],
  ];

  for (const [label, input] of rejects) {
    it(`rejects ${label}`, () => {
      assert.equal(parseXbrlFinancials(input), null);
    });
  }

  it("rejects a header-only truncation — contexts and facts both lost", () => {
    const cut = GLAXO_XML.indexOf("<xbrli:context");
    assert.ok(cut > 0);
    assert.equal(parseXbrlFinancials(GLAXO_XML.slice(0, cut)), null);
  });

  it("rejects a filing whose only facts sit in dimensioned contexts", () => {
    // Recognised taxonomy, real facts, no attributable period. Returning the
    // numbers anyway is precisely how a segment figure becomes a headline.
    const xml = synth({
      contexts: [
        {
          id: "OneReportableSegmentRevenue01D",
          start: "2025-07-01",
          end: "2025-09-30",
          dimension: "ReportableSegmentsAxis",
        },
      ],
      facts: [
        {
          tag: "RevenueFromOperations",
          context: "OneReportableSegmentRevenue01D",
          value: "250",
        },
      ],
    });
    assert.equal(parseXbrlFinancials(xml), null);
  });

  it("a mid-facts truncation yields REDUCED coverage, not null and not {}", () => {
    // The distinction the caller depends on: this document is real, its period
    // is real, and its revenue is real — there is just less of it.
    const cut = GLAXO_XML.indexOf("<in-bse-fin:OtherIncome");
    assert.ok(cut > 0);
    const r = parsed(GLAXO_XML.slice(0, cut));

    assert.equal(r.period.start, "2024-07-01");
    assert.equal(r.period.end, "2024-09-30");
    assert.equal(r.values.revenueFromOperations, 10_000_500_000);
    // Below the headline bar (no profit), yet plainly not empty.
    assert.equal(r.coverage.level, "none");
    assert.deepEqual(r.coverage.present, ["revenueFromOperations"]);
    assert.ok(r.coverage.missing.includes("profitForPeriod"));
    assert.ok(r.coverage.missing.length > 10);
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage reporting                                                          */
/* -------------------------------------------------------------------------- */

describe("coverage reporting", () => {
  it("climbs the ladder none → headline → income → full", () => {
    const base = (extra: SynthFact[]): XbrlFinancials =>
      parsed(
        synth({
          contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
          facts: [...periodFacts("OneD", "2025-07-01", "2025-09-30"), ...extra],
        }),
      );
    const f = (tag: string, value: string): SynthFact => ({
      tag,
      context: "OneD",
      value,
    });

    assert.equal(base([f("OtherIncome", "5")]).coverage.level, "none");

    const headline = [
      f("RevenueFromOperations", "1000"),
      f("ProfitLossForPeriod", "100"),
    ];
    assert.equal(base(headline).coverage.level, "headline");

    const income = [
      ...headline,
      f("Income", "1050"),
      f("Expenses", "900"),
      f("ProfitBeforeTax", "150"),
      f("TaxExpense", "50"),
    ];
    assert.equal(base(income).coverage.level, "income");
  });

  it("reaches `full` only once the balance sheet resolves", () => {
    const facts: SynthFact[] = [
      ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
      { tag: "RevenueFromOperations", context: "OneD", value: "1000" },
      { tag: "ProfitLossForPeriod", context: "OneD", value: "100" },
      { tag: "Income", context: "OneD", value: "1050" },
      { tag: "Expenses", context: "OneD", value: "900" },
      { tag: "ProfitBeforeTax", context: "OneD", value: "150" },
      { tag: "TaxExpense", context: "OneD", value: "50" },
    ];
    const withoutBs = parsed(
      synth({
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts,
      }),
    );
    assert.equal(withoutBs.coverage.level, "income");

    const withBs = parsed(
      synth({
        contexts: [
          { id: "OneD", start: "2025-07-01", end: "2025-09-30" },
          { id: "OneI", instant: "2025-09-30" },
        ],
        facts: [...facts, { tag: "Assets", context: "OneI", value: "9000" }],
      }),
    );
    assert.equal(withBs.coverage.level, "full");
  });

  it("`present` and `missing` partition the family's expected concepts", () => {
    const r = parsed(BHARTI_XML);
    const overlap = r.coverage.present.filter((c) =>
      r.coverage.missing.includes(c),
    );
    assert.deepEqual(overlap, []);
    for (const c of r.coverage.present) {
      assert.notEqual(r.values[c], undefined, `${c} present but has no value`);
    }
    for (const c of r.coverage.missing) {
      assert.equal(r.values[c], undefined, `${c} missing but has a value`);
    }
  });

  it("both lists are sorted, so diffs between filings are stable", () => {
    const r = parsed(ICICI_XML);
    assert.deepEqual(r.coverage.present, [...r.coverage.present].sort());
    assert.deepEqual(r.coverage.missing, [...r.coverage.missing].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* Value handling at the boundary                                             */
/* -------------------------------------------------------------------------- */

describe("value coercion at the boundary", () => {
  const parseValue = (raw: string): number | undefined =>
    parsed(
      synth({
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts: [
          ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
          { tag: "ProfitLossForPeriod", context: "OneD", value: "1" },
          { tag: "RevenueFromOperations", context: "OneD", value: raw },
        ],
      }),
    ).values.revenueFromOperations;

  it("keeps a reported 0 — zero is a value, not an absence", () => {
    assert.equal(parseValue("0.00"), 0);
  });

  it("keeps negatives", () => {
    assert.equal(parseValue("-1234.5"), -1234.5);
  });

  for (const bad of [
    "NaN",
    "Infinity",
    "-Infinity",
    "",
    "  ",
    "1,234",
    "n/a",
  ]) {
    it(`drops the non-finite value ${JSON.stringify(bad)} rather than storing it`, () => {
      const v = parseValue(bad);
      assert.equal(v, undefined);
      // The specific failure this guards: `Number("")` is 0, so a blank fact
      // would otherwise be reported as a genuine zero.
      assert.notEqual(v, 0);
    });
  }

  it("treats an xsi:nil fact as absent, not as zero", () => {
    const r = parsed(
      synth({
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts: [
          ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
          { tag: "ProfitLossForPeriod", context: "OneD", value: "1" },
          {
            tag: "RevenueFromOperations",
            context: "OneD",
            value: "",
            nil: true,
          },
        ],
      }),
    );
    assert.equal(r.values.revenueFromOperations, undefined);
    assert.ok(r.coverage.missing.includes("revenueFromOperations"));
  });

  it("every extracted value is finite", () => {
    for (const xml of [GLAXO_XML, ICICI_XML, BHARTI_XML]) {
      for (const [k, v] of Object.entries(parsed(xml).values)) {
        assert.ok(Number.isFinite(v), `${k} is not finite: ${String(v)}`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Taxonomy version handling                                                  */
/* -------------------------------------------------------------------------- */

describe("taxonomy version is discovered, not hardcoded", () => {
  it("reads three different versions from the three fixtures", () => {
    assert.deepEqual(
      [GLAXO_XML, ICICI_XML, BHARTI_XML].map((x) => parsed(x).taxonomy.version),
      ["2020-03-31", "2019-09-30", "2018-03-31"],
    );
  });

  it("parses an unseen future version through the same table", () => {
    const r = parsed(
      synth({
        version: "2031-03-31",
        contexts: [{ id: "OneD", start: "2031-07-01", end: "2031-09-30" }],
        facts: [
          ...periodFacts("OneD", "2031-07-01", "2031-09-30"),
          { tag: "RevenueFromOperations", context: "OneD", value: "42" },
        ],
      }),
    );
    assert.equal(r.taxonomy.version, "2031-03-31");
    assert.equal(r.values.revenueFromOperations, 42);
  });

  it("does not key off the sibling -roles / -types namespaces", () => {
    // The same document declares in-bse-fin, -roles, -types and -ent. A loose
    // match takes whichever is declared first and keys the table off the wrong
    // schema's URI.
    const r = parsed(GLAXO_XML);
    assert.ok(r.taxonomy.namespace.endsWith("/in-bse-fin"));
    assert.ok(!r.taxonomy.namespace.includes("roles"));
    assert.ok(!r.taxonomy.namespace.includes("types"));
  });

  it("honours whatever prefix the document binds", () => {
    const r = parsed(
      synth({
        taxPrefix: "fin",
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts: [
          ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
          { tag: "RevenueFromOperations", context: "OneD", value: "7" },
        ],
      }),
    );
    assert.equal(r.taxonomy.prefix, "fin");
    assert.equal(r.values.revenueFromOperations, 7);
  });

  it("resolveConceptTable exposes the mapping for every concept", () => {
    const table = resolveConceptTable("2020-03-31");
    assert.deepEqual(table.get("revenueFromOperations"), [
      "RevenueFromOperations",
      "InterestEarned",
    ]);
    assert.deepEqual(table.get("profitForPeriod"), [
      "ProfitLossForPeriod",
      "ProfitLossForThePeriod",
    ]);
    for (const [concept, tags] of table) {
      assert.ok(tags.length > 0, `${concept} has no candidate tags`);
    }
  });

  it("resolves the same table across the three observed versions", () => {
    // Documents the finding: the local names are stable 2018 → 2020, so the
    // FAMILY is what varies, not the version. If a future version ever needs an
    // override this assertion is where it announces itself.
    const a = resolveConceptTable("2018-03-31");
    const b = resolveConceptTable("2020-03-31");
    assert.deepEqual([...a.entries()], [...b.entries()]);
  });
});

/* -------------------------------------------------------------------------- */
/* Family detection                                                            */
/* -------------------------------------------------------------------------- */

describe("family detection", () => {
  it("uses the schemaRef href, not a grep of the document", () => {
    // The filings carry a free-text notes block; a document-wide search for
    // "banking" would let a note reclassify a manufacturer as a bank.
    const r = parsed(
      synth({
        schemaRef: "Ind-AS_entry_point_2020-03-31.xsd",
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts: [
          ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
          { tag: "RevenueFromOperations", context: "OneD", value: "10" },
          {
            tag: "DisclosureOfNotesOnFinancialResultsExplanatoryTextBlock",
            context: "OneD",
            value:
              "Balances with banking companies under the banking entry point",
          },
        ],
      }),
    );
    assert.equal(r.family, "ind-as");
  });

  it("falls back to bank-only tags when the schemaRef is unhelpful", () => {
    const r = parsed(
      synth({
        schemaRef: "unknown.xsd",
        contexts: [{ id: "OneD", start: "2025-07-01", end: "2025-09-30" }],
        facts: [
          ...periodFacts("OneD", "2025-07-01", "2025-09-30"),
          { tag: "NameOfBank", context: "OneD", value: "Test Bank Limited" },
          { tag: "InterestEarned", context: "OneD", value: "5000" },
        ],
      }),
    );
    assert.equal(r.family, "banking");
    assert.equal(r.companyName, "Test Bank Limited");
    assert.equal(r.values.revenueFromOperations, 5000);
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe("purity", () => {
  it("is deterministic — repeated parses are deep-equal", () => {
    assert.deepEqual(
      parseXbrlFinancials(GLAXO_XML),
      parseXbrlFinancials(GLAXO_XML),
    );
    assert.deepEqual(
      parseXbrlFinancials(ICICI_XML),
      parseXbrlFinancials(ICICI_XML),
    );
  });

  it("keeps no state between calls — interleaving does not change results", () => {
    const first = parseXbrlFinancials(GLAXO_XML);
    parseXbrlFinancials(ICICI_XML);
    parseXbrlFinancials(BHARTI_XML);
    parseXbrlFinancials("garbage");
    assert.deepEqual(parseXbrlFinancials(GLAXO_XML), first);
  });

  it("returns a fresh object — mutating the result cannot leak into the next parse", () => {
    // A module-level regex with the /g flag carries `lastIndex` across calls;
    // a cached result object would be shared. Both would surface here.
    const a = parsed(GLAXO_XML);
    a.values.revenueFromOperations = -1;
    a.coverage.present.length = 0;
    const b = parsed(GLAXO_XML);
    assert.equal(b.values.revenueFromOperations, 10_000_500_000);
    assert.ok(b.coverage.present.length > 0);
  });
});
