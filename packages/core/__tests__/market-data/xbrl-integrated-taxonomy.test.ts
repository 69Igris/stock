/**
 * UNIT TEST — the SEBI INTEGRATED XBRL taxonomy (MONEY-1200).
 *
 * ## The defect this file exists to prevent
 *
 * `xbrl_filings` was EMPTY on prod. One run's own result object, measured
 * 2026-08-14:
 *
 *     listed: 1866  downloaded: 1500  unparseable: 1499  written: 0  ok: true
 *
 * The parser had been built and tested exclusively against the BSE-hosted
 * `in-bse-fin` taxonomy. Every CURRENT filing is served in SEBI's `in-capmkt`
 * taxonomy instead, so `findTaxonomy` returned null on 1,499 well-formed
 * documents and the job reported success. `xbrl-financials-logic.test.ts`
 * stayed green throughout, because all three of its fixtures are legacy-era.
 *
 * That is why this file's fixtures are the point of it. Six integrated-era
 * filings, fetched live 2026-08-14, covering every entry point SEBI publishes
 * and three taxonomy versions:
 *
 * | fixture      | symbol     | period  | entry point                      | version    |
 * |--------------|------------|---------|----------------------------------|------------|
 * | infy…        | INFY       | Q1 FY27 | IntegratedFinance_IndAS          | 2026-01-31 |
 * | cipla…       | CIPLA      | Q3 FY26 | IntegratedFinance_IndAS          | 2025-01-31 |
 * | tataconsum…  | TATACONSUM | Q4 FY26 | IntegratedFinance_IndAS          | 2026-01-31 |
 * | ndgl…        | NDGL       | Q1 FY27 | IntegratedFinance_NBFC           | 2026-01-31 |
 * | religare…    | RELIGARE   | Q4 FY26 | IntegratedFinance_NBFC           | 2026-01-31 |
 * | finopb…      | FINOPB     | Q1 FY27 | IntegratedFinance_Banking        | 2026-01-31 |
 * | aifl…        | AIFL       | Q1 FY27 | IntegratedFinance_OtherThanBank  | 2026-01-31 |
 * | dycl…        | DYCL       | Q4 FY26 | IntegratedFinance_OtherThanBank  | 2026-01-31 |
 * | infy…gov…    | INFY       | Q1 FY27 | IntegratedGovernance             | 2024-12-31 |
 *
 * The four `.trimmed.xml` ones had whole elements REMOVED (annual filings run
 * to 1 MB of related-party and segment breakdowns); everything kept is
 * byte-verbatim, contexts and facts sliced out of the download and
 * re-concatenated in document order. Nothing was re-serialised, so the traps
 * that only exist in the real bytes still exist here.
 *
 * ## Values are the filings' own published figures
 *
 * Infosys Q1-FY27 standalone revenue ₹39,957 Cr / PAT ₹7,249 Cr / basic EPS
 * 17.87. Tata Consumer Q4-FY26 standalone revenue ₹3,891.76 Cr with total
 * assets ₹22,629.90 Cr. Fino Payments Bank Q1-FY27 interest earned ₹72.23 Cr
 * against a ₹13.72 Cr loss. Asserting real numbers means a wrong-context or
 * wrong-tag regression shows up as a wrong REAL number, not as a diff against
 * a golden blob.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseXbrlDocument,
  parseXbrlFinancials,
  resolveConceptTable,
  type XbrlFinancials,
} from "../../src/market-data/xbrl-financials-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl");
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const INFY_XML = read("infy-q1fy27-standalone-indas-2026-01-31.xml");
const CIPLA_XML = read("cipla-q3fy26-standalone-indas-2025-01-31.xml");
const TATACONSUM_XML = read(
  "tataconsum-q4fy26-standalone-indas-2026-01-31.trimmed.xml",
);
const NDGL_XML = read("ndgl-q1fy27-consolidated-nbfc-2026-01-31.xml");
const RELIGARE_XML = read(
  "religare-q4fy26-standalone-nbfc-2026-01-31.trimmed.xml",
);
const FINOPB_XML = read("finopb-q1fy27-standalone-banking-2026-01-31.xml");
const AIFL_XML = read("aifl-q1fy27-standalone-nonindas-2026-01-31.xml");
const DYCL_XML = read("dycl-q4fy26-standalone-nonindas-2026-01-31.trimmed.xml");
const GOVERNANCE_XML = read("infy-q1fy27-governance-2024-12-31.trimmed.xml");

/** Legacy-era, so the regression check below is against real old filings. */
const GLAXO_XML = read("glaxo-q2fy25-standalone-indas-2020-03-31.xml");
const ICICI_XML = read("icicibank-q2fy25-standalone-banking-2019-09-30.xml");

/** Parse-or-fail, so a regression fails on the assertion, not a TypeError. */
function parsed(xml: string): XbrlFinancials {
  const o = parseXbrlDocument(xml);
  assert.equal(
    o.kind,
    "financials",
    `expected financials, got ${o.kind}: ${JSON.stringify(o).slice(0, 300)}`,
  );
  assert.ok(o.kind === "financials");
  return o.financials;
}

/** Every taxonomy-prefixed element local name in a document. */
function elementNames(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /<in-capmkt:([A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.add(m[1] ?? "");
  return out;
}

/* -------------------------------------------------------------------------- */
/* The guard that guards the guards                                           */
/* -------------------------------------------------------------------------- */

describe("the integrated fixtures actually reach the parser", () => {
  // Without this, a renamed or moved fixture turns every assertion below into
  // an assertion about a throw that never happens, and a suite that asserts
  // nothing passes. It is the same class of hole as the original defect: the
  // legacy suite stayed green while the parser understood nothing current.
  it("all eight financial fixtures parse, with the entry point this file assumes", () => {
    assert.deepEqual(
      [
        INFY_XML,
        CIPLA_XML,
        TATACONSUM_XML,
        NDGL_XML,
        RELIGARE_XML,
        FINOPB_XML,
        AIFL_XML,
        DYCL_XML,
      ]
        .map(parsed)
        .map(
          (f) =>
            `${f.symbol}/${f.taxonomy.entryPoint}/${f.family}/${f.taxonomy.version}`,
        ),
      [
        "INFY/IntegratedFinance_IndAS/ind-as/2026-01-31",
        "CIPLA/IntegratedFinance_IndAS/ind-as/2025-01-31",
        "TATACONSUM/IntegratedFinance_IndAS/ind-as/2026-01-31",
        "NDGL/IntegratedFinance_NBFC/nbfc/2026-01-31",
        "RELIGARE/IntegratedFinance_NBFC/nbfc/2026-01-31",
        "FINOPB/IntegratedFinance_Banking/banking/2026-01-31",
        "AIFL/IntegratedFinance_OtherThanBank/non-ind-as/2026-01-31",
        "DYCL/IntegratedFinance_OtherThanBank/non-ind-as/2026-01-31",
      ],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Namespace dispatch                                                         */
/* -------------------------------------------------------------------------- */

describe("dispatch is on the DECLARED namespace", () => {
  // THE defect. Before this, `findTaxonomy` matched only
  // `…/xbrl/fin/{date}/in-bse-fin` and returned null for every integrated
  // filing — 1,499 of 1,500 downloads on prod. The job then counted them as
  // "unparseable" and reported ok.
  it("reads the SEBI in-capmkt taxonomy, not only the BSE in-bse-fin one", () => {
    const r = parsed(INFY_XML);
    assert.equal(r.taxonomy.dialect, "in-capmkt");
    assert.equal(
      r.taxonomy.namespace,
      "http://www.sebi.gov.in/xbrl/2026-01-31/in-capmkt",
    );
    assert.equal(r.taxonomy.prefix, "in-capmkt");
  });

  it("still reads the legacy BSE taxonomy — the eras coexist", () => {
    const r = parsed(GLAXO_XML);
    assert.equal(r.taxonomy.dialect, "in-bse-fin");
    assert.equal(r.taxonomy.version, "2020-03-31");
    assert.equal(r.taxonomy.entryPoint, null);
  });

  // The `$` anchor. The same document declares
  // `…/IntegratedFinance_IndAS/2026-01-31/in-capmkt/in-capmkt-ent`, which
  // CONTAINS `/in-capmkt` as an interior segment, and `…/2026-01-31/
  // in-capmkt-types`. An unanchored match takes whichever is declared first,
  // so the version and namespace would be read off a sibling schema — and
  // since both siblings carry the same date today, the bug would be silent
  // until the first release where they diverge.
  it("does not mistake the -ent or -types sibling namespace for the taxonomy", () => {
    const r = parsed(INFY_XML);
    assert.ok(
      !r.taxonomy.namespace.includes("in-capmkt-ent"),
      `picked a sibling schema: ${r.taxonomy.namespace}`,
    );
    assert.ok(!r.taxonomy.namespace.includes("in-capmkt-types"));
    assert.ok(INFY_XML.includes("/in-capmkt/in-capmkt-ent"), "fixture premise");
    assert.ok(INFY_XML.includes("in-capmkt-types"), "fixture premise");
  });

  // A version pinned in code silently stops matching the moment SEBI ships the
  // next annual taxonomy. It has already happened twice: 2024-12-31 →
  // 2025-01-31 → 2026-01-31, all three live in these fixtures.
  it("discovers the version rather than assuming one — three are in play", () => {
    assert.equal(parsed(INFY_XML).taxonomy.version, "2026-01-31");
    assert.equal(parsed(CIPLA_XML).taxonomy.version, "2025-01-31");
    const gov = parseXbrlDocument(GOVERNANCE_XML);
    assert.ok(gov.kind === "non-financial");
    assert.equal(gov.taxonomy.version, "2024-12-31");
  });

  // These filings carry a free-text `DisclosureOfNotesOnFinancialResults…`
  // block of entity-escaped HTML that a filer writes by hand. Scanning the
  // WHOLE document for `xmlns:` lets that prose choose the taxonomy. Scoping
  // the scan to the root element's attributes is what makes the dispatch
  // un-steerable.
  it("reads namespaces off the ROOT ELEMENT, so a filer's notes cannot vote", () => {
    const forged =
      '<in-capmkt:DisclosureOfNotesOnFinancialResultsExplanatoryTextBlock contextRef="OneD">' +
      'see xmlns:evil="http://www.bseindia.com/xbrl/fin/1999-01-01/in-bse-fin"' +
      "</in-capmkt:DisclosureOfNotesOnFinancialResultsExplanatoryTextBlock>";
    const withNotes = INFY_XML.replace(
      "</xbrli:xbrl>",
      `${forged}</xbrli:xbrl>`,
    );
    const r = parsed(withNotes);
    assert.equal(r.taxonomy.dialect, "in-capmkt");
    assert.equal(r.taxonomy.version, "2026-01-31");
  });
});

/* -------------------------------------------------------------------------- */
/* Unknown taxonomies are COUNTED, never parsed as zero                       */
/* -------------------------------------------------------------------------- */

describe("an unrecognised taxonomy is a distinct, reported outcome", () => {
  // The whole point of MONEY-1200. A taxonomy we have not been taught must
  // NEVER be indistinguishable from "this filing had no numbers" — that
  // equivalence is what turned a total ingestion failure into `ok: true`.
  it("reports unknown-taxonomy WITH the namespaces it saw", () => {
    const alien = INFY_XML.replace(
      "http://www.sebi.gov.in/xbrl/2026-01-31/in-capmkt",
      "http://www.sebi.gov.in/xbrl/2031-01-31/in-esg",
    );
    const o = parseXbrlDocument(alien);
    assert.equal(o.kind, "unknown-taxonomy");
    assert.ok(o.kind === "unknown-taxonomy");
    assert.ok(
      o.namespaces.some((n) => n.includes("in-esg")),
      `namespaces must be reported so the fix is one table entry: ${o.namespaces}`,
    );
  });

  // A NEW entry point under a KNOWN namespace is the likelier next break —
  // SEBI adds one per filer class. Reading an insurance or REIT filing through
  // the Ind-AS concept map would produce plausible numbers filed under the
  // wrong concepts, which is strictly worse than a counted gap. So it is
  // refused, not best-efforted.
  it("refuses an unknown ENTRY POINT rather than guessing ind-as", () => {
    const alien = INFY_XML.replace(
      "IntegratedFinance_IndAS",
      "IntegratedFinance_Insurance",
    );
    const o = parseXbrlDocument(alien);
    assert.equal(o.kind, "unknown-entry-point");
    assert.ok(o.kind === "unknown-entry-point");
    assert.equal(o.entryPoint, "IntegratedFinance_Insurance");
    assert.equal(o.taxonomy.dialect, "in-capmkt");
  });

  it("distinguishes not-xbrl from a taxonomy it cannot read", () => {
    // The 404 body NSE serves for its own stub URL is HTML, not a taxonomy
    // problem. Conflating the two makes a transport story look like a parser
    // story and sends the next investigation to the wrong module.
    assert.equal(
      parseXbrlDocument(read("nse-missing-xbrl-404.html")).kind,
      "not-xbrl",
    );
    assert.equal(parseXbrlDocument("").kind, "not-xbrl");
    assert.equal(
      parseXbrlDocument("<html><body>nope</body></html>").kind,
      "not-xbrl",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Governance filings are healthy, not failures                               */
/* -------------------------------------------------------------------------- */

describe("governance filings carry no financials BY DESIGN", () => {
  // 29 of 500 records in a live window are governance filings. Counting them
  // as `unparseable` puts a permanent ~6% floor under the failure ratio, which
  // forces the alerting threshold up above the noise and blunts the exact
  // signal the threshold exists to give.
  it("classifies a governance filing as non-financial, not unparseable", () => {
    const o = parseXbrlDocument(GOVERNANCE_XML);
    assert.equal(o.kind, "non-financial");
    assert.ok(o.kind === "non-financial");
    assert.equal(o.reason, "governance");
    assert.equal(o.taxonomy.entryPoint, "IntegratedGovernance");
  });

  it("the fixture really has no financial concepts — the classification is not a shortcut", () => {
    const names = elementNames(GOVERNANCE_XML);
    for (const tag of [
      "RevenueFromOperations",
      "Income",
      "Expenses",
      "ProfitBeforeTax",
      "ProfitLossForPeriod",
      "InterestEarned",
      "TaxExpense",
    ]) {
      assert.ok(
        !names.has(tag),
        `governance filing unexpectedly carries ${tag}`,
      );
    }
    // …while still being a real, populated filing rather than an empty stub.
    assert.ok(
      names.size > 40,
      `only ${names.size} elements — fixture may be over-trimmed`,
    );
    assert.ok(names.has("NoOfInvestorComplaints"));
    assert.ok(
      names.has(
        "TheCompositionOfBoardOfDirectorsIsInTermsOfSebiRegulations2015",
      ),
    );
  });

  it("the null-returning wrapper does NOT hand a caller a fake financials object", () => {
    assert.equal(parseXbrlFinancials(GOVERNANCE_XML), null);
  });
});

/* -------------------------------------------------------------------------- */
/* Concept mapping — Ind-AS                                                   */
/* -------------------------------------------------------------------------- */

describe("INFY Q1 FY27 (in-capmkt, ind-as, standalone, 2026-01-31)", () => {
  const r = parsed(INFY_XML);

  it("reads the identity off the filing", () => {
    assert.equal(r.symbol, "INFY");
    assert.equal(r.companyName, "INFOSYS LIMITED");
    assert.equal(r.isin, "INE009A01021");
    assert.equal(r.basis, "standalone");
    // Infosys audits its quarterly results; most filers do not. Asserting
    // `true` here catches a parser that defaults the flag instead of reading it.
    assert.equal(r.audited, true);
    assert.equal(r.currency, "INR");
  });

  // `LevelOfRoundingUsedInFinancialStatements` in the legacy taxonomy became a
  // bare `LevelOfRounding`. Missing it makes every integrated filing report a
  // null rounding label — the one field that would reveal a filer breaking the
  // absolute-rupees convention.
  it("reads LevelOfRounding, the integrated spelling of the rounding label", () => {
    assert.equal(r.roundingLabel, "Crores");
    assert.ok(
      INFY_XML.includes("<in-capmkt:LevelOfRounding "),
      "fixture premise",
    );
    assert.ok(
      !INFY_XML.includes("LevelOfRoundingUsedInFinancialStatements"),
      "fixture premise: the legacy spelling is absent",
    );
  });

  it("picks the quarter from the reporting-period FACTS", () => {
    assert.deepEqual(
      { start: r.period.start, end: r.period.end, source: r.period.source },
      { start: "2026-04-01", end: "2026-06-30", source: "reported-facts" },
    );
  });

  // Published Q1-FY27 standalone figures. Values are absolute rupees despite
  // the "Crores" label — the label is presentation for the printed statement,
  // exactly as in the legacy era. A parser that rescaled by the label would
  // report ₹39,957 Cr as ₹399,570,000,000 Cr.
  it("extracts the published income statement, in absolute rupees", () => {
    assert.equal(r.values.revenueFromOperations, 399_570_000_000);
    assert.equal(r.values.otherIncome, 8_740_000_000);
    assert.equal(r.values.totalIncome, 408_310_000_000);
    assert.equal(r.values.totalExpenses, 306_700_000_000);
    assert.equal(r.values.employeeBenefitExpense, 188_200_000_000);
    assert.equal(r.values.financeCosts, 610_000_000);
    assert.equal(r.values.depreciationAndAmortisation, 6_130_000_000);
    assert.equal(r.values.profitBeforeTax, 101_610_000_000);
    assert.equal(r.values.taxExpense, 29_120_000_000);
    assert.equal(r.values.profitForPeriod, 72_490_000_000);
    assert.equal(r.values.basicEps, 17.87);
    assert.equal(r.values.dilutedEps, 17.86);
  });

  // A quarterly integrated filing carries no balance sheet at all — its `OneI`
  // instant context holds only debt-default disclosures. `null` is the honest
  // answer; zeroes would be invented equity.
  it("reports no balance sheet rather than zeroes, for a quarter that has none", () => {
    assert.equal(r.balanceSheetDate, null);
    assert.equal(r.balanceSheetSource, null);
    assert.equal(r.values.totalAssets, undefined);
    assert.equal(r.coverage.level, "income");
  });

  it("finds every income and per-share concept its family is expected to carry", () => {
    // 17 -> 20: MONEY-1220 mapped the three Ind-AS cost-of-goods lines
    // (CostOfMaterialsConsumed, PurchasesOfStockInTrade, ChangesInInventories)
    // that gross margin needs. `present` and `expected` moved TOGETHER, which is
    // the property this assertion exists to pin — full coverage of whatever the
    // family declares. The literal has to be bumped whenever `CONCEPTS` grows;
    // that is deliberate friction, so adding a concept without a filing that
    // carries it shows up here rather than as a quiet coverage hole.
    assert.deepEqual(r.coverage.byGroup.income, { present: 20, expected: 20 });
    assert.deepEqual(r.coverage.byGroup.perShare, { present: 6, expected: 6 });
  });
});

describe("the entity identifier's SCHEME decides whether it is a symbol", () => {
  // Integrated filings identify the entity by `…/ScripCode` or by `…/Symbol`,
  // and WHICH ONE varies by filer: Infosys and Cipla use ScripCode, NDGL and
  // Axis Bank use Symbol. Reading the identifier without reading its scheme
  // reports "500209" as Infosys's trading symbol — a value that joins to no
  // instrument, looks like data in a log, and would be written straight into
  // `XbrlFiling.symbol`.
  it("does not report a BSE scrip code as the NSE symbol", () => {
    const r = parsed(INFY_XML);
    assert.ok(
      INFY_XML.includes(
        '<xbrli:identifier scheme="http://www.sebi.gov.in/in-capmkt/ScripCode">500209<',
      ),
      "fixture premise: the entity identifier IS the scrip code",
    );
    assert.equal(r.symbol, "INFY");
    assert.notEqual(r.symbol, "500209");
    assert.equal(r.scripCode, "500209");
  });

  it("still prefers the identifier when its scheme says symbol", () => {
    const ndgl = parsed(NDGL_XML);
    assert.ok(
      NDGL_XML.includes(
        'scheme="http://www.sebi.gov.in/in-capmkt/Symbol">NDGL<',
      ),
      "fixture premise",
    );
    assert.equal(ndgl.symbol, "NDGL");
    // "000000" is what NDGL files for a company that is not listed on BSE. It
    // is preserved rather than normalised away: an unlisted marker is data.
    assert.equal(ndgl.scripCode, "000000");
  });

  it("legacy filings are unaffected — their scheme is NSESymbol", () => {
    const glaxo = parsed(GLAXO_XML);
    assert.equal(glaxo.symbol, "GLAXO");
    assert.equal(glaxo.scripCode, "500660");
  });
});

/* -------------------------------------------------------------------------- */
/* Concept mapping — NBFC, the family that was being read as a bank           */
/* -------------------------------------------------------------------------- */

describe("NDGL Q1 FY27 (in-capmkt, NBFC) — the InterestEarned trap", () => {
  const r = parsed(NDGL_XML);

  // The old family detector was "the document mentions `InterestEarned`,
  // therefore it is a bank". That holds in the legacy taxonomy and FAILS in
  // the integrated one: an NBFC files BOTH. The entry-point namespace states
  // the family outright, so the inference was never needed.
  it("classifies an NBFC as nbfc, not as a bank, from the DECLARED entry point", () => {
    assert.equal(r.family, "nbfc");
    assert.equal(r.familySource, "entry-point");
    assert.ok(
      NDGL_XML.includes("<in-capmkt:InterestEarned "),
      "fixture premise: the NBFC really does file InterestEarned",
    );
  });

  // The two tags sit in the SAME context, 240x apart. Resolving revenue to the
  // bank tag would report ₹3.93 lakh of revenue for a company that earned
  // ₹94.48 Cr — a number small enough to look like a micro-cap rather than
  // like a bug.
  it("takes RevenueFromOperations over InterestEarned when both are present", () => {
    assert.equal(r.values.revenueFromOperations, 944_790_000);
    assert.notEqual(r.values.revenueFromOperations, 393_000);
  });

  // Misclassified as a bank, this filing reported fourteen RBI concepts it can
  // never have (Deposits, Advances, CET1Ratio, …) as MISSING, dropping its
  // stored `coverage` by roughly half and making a complete filing look
  // deficient.
  it("does not report RBI-only concepts as missing on an NBFC", () => {
    for (const c of [
      "deposits",
      "advances",
      "bankCapital",
      "cet1Ratio",
      "grossNpa",
      "operatingProfitBeforeProvisions",
    ]) {
      assert.ok(
        !r.coverage.missing.includes(c as never),
        `${c} must not be expected of an NBFC`,
      );
    }
  });

  it("extracts the consolidated income statement including the minority split", () => {
    assert.equal(r.values.totalIncome, 954_400_000);
    assert.equal(r.values.profitBeforeTax, 195_362_000);
    assert.equal(r.values.taxExpense, 98_860_000);
    assert.equal(r.values.profitForPeriod, 384_062_000);
    assert.equal(r.values.shareOfProfitOfAssociates, 287_560_000);
    assert.equal(r.values.profitAttributableToOwners, 363_577_000);
    assert.equal(
      r.values.profitAttributableToNonControllingInterests,
      20_485_000,
    );
    assert.equal(r.basis, "consolidated");
  });
});

/* -------------------------------------------------------------------------- */
/* Concept mapping — integrated banking                                       */
/* -------------------------------------------------------------------------- */

describe("FINOPB Q1 FY27 (in-capmkt, banking)", () => {
  const r = parsed(FINOPB_XML);

  // In the LEGACY taxonomy the banking entry point announced itself in the
  // `<link:schemaRef>` href (`banking_entry_point_*.xsd`). In the integrated
  // taxonomy EVERY entry point points at the same
  // `in-capmkt-ent-2026-01-31.xsd`, so that signal is gone — the href carries
  // no family information at all. Only the entry-point namespace does.
  it("classifies the bank from the entry point, not from a schemaRef that no longer says", () => {
    assert.equal(r.family, "banking");
    assert.equal(r.familySource, "entry-point");
    assert.ok(
      FINOPB_XML.includes('xlink:href="in-capmkt-ent-2026-01-31.xsd"'),
      "fixture premise: the schemaRef is family-neutral",
    );
    assert.ok(!/schemaRef[^>]*banking/i.test(FINOPB_XML), "fixture premise");
  });

  it("maps the RBI Form-A tags onto the same canonical keys as a manufacturer", () => {
    // A bank's top line is interest earned; downstream code must never branch.
    assert.equal(r.values.revenueFromOperations, 722_300_000);
    assert.equal(r.values.otherIncome, 2_346_400_000);
    assert.equal(r.values.totalIncome, 3_068_700_000);
    // ExpenditureExcludingProvisionsAndContingencies / InterestExpended /
    // EmployeesCost / ProfitLossFromOrdinaryActivitiesBeforeTax.
    assert.equal(r.values.totalExpenses, 3_205_900_000);
    assert.equal(r.values.financeCosts, 353_300_000);
    assert.equal(r.values.employeeBenefitExpense, 578_400_000);
    assert.equal(r.values.profitBeforeTax, -137_200_000);
    // `ProfitLossForThePeriod` — the banking spelling, with the extra "The".
    assert.equal(r.values.profitForPeriod, -137_200_000);
    // `BasicEarningsPerShareAfterExtraordinaryItems`, not the Ind-AS spelling.
    assert.equal(r.values.basicEps, -1.65);
  });

  it("keeps the bank-only prudential ratios, including genuine zeroes", () => {
    assert.equal(r.values.operatingProfitBeforeProvisions, -137_200_000);
    assert.equal(r.values.cet1Ratio, 0.7346);
    assert.equal(r.values.returnOnAssets, -0.0025);
    // 0 is a REPORTED value here, not an absence. A truthiness check would
    // drop a clean loan book and report "no NPA data".
    assert.equal(r.values.grossNpa, 0);
    assert.equal(r.values.netNpa, 0);
    assert.ok(r.coverage.present.includes("grossNpa"));
  });

  it("does not report Ind-AS-only concepts as missing on a bank", () => {
    for (const c of [
      "inventories",
      "depreciationAndAmortisation",
      "otherEquity",
    ]) {
      assert.ok(!r.coverage.missing.includes(c as never), `${c} on a bank`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Concept mapping — Indian GAAP ("other than bank")                          */
/* -------------------------------------------------------------------------- */

describe("AIFL Q1 FY27 (in-capmkt, non-ind-as) — the renamed tags", () => {
  const r = parsed(AIFL_XML);

  it("is its own family, not ind-as", () => {
    assert.equal(r.family, "non-ind-as");
    assert.equal(r.familySource, "entry-point");
  });

  // Indian GAAP drops "Depletion" and inserts a "The". Each of these was
  // verified as the local name the fixture actually files; mapped through the
  // Ind-AS names they read as absent, and the concept goes missing from every
  // non-Ind-AS filer forever with nothing to indicate it.
  it("reads the Indian-GAAP spellings the Ind-AS map cannot see", () => {
    const names = elementNames(AIFL_XML);
    assert.ok(names.has("DepreciationAndAmortisationExpense"));
    assert.ok(!names.has("DepreciationDepletionAndAmortisationExpense"));
    assert.ok(names.has("ProfitLossForThePeriodFromContinuingOperations"));
    assert.ok(names.has("ProfitLossFromDiscontinuingOperationAfterTax"));

    // 0, and PRESENT. A company with no depreciation this quarter is not a
    // company with unknown depreciation.
    assert.equal(r.values.depreciationAndAmortisation, 0);
    assert.ok(r.coverage.present.includes("depreciationAndAmortisation"));
    assert.equal(r.values.profitFromContinuingOperations, 1_031_000);
    assert.equal(r.values.profitFromDiscontinuedOperationsAfterTax, 0);
  });

  it("extracts the income statement", () => {
    assert.equal(r.values.revenueFromOperations, 39_851_000);
    assert.equal(r.values.totalIncome, 39_851_000);
    assert.equal(r.values.totalExpenses, 38_473_000);
    assert.equal(r.values.profitBeforeTax, 1_378_000);
    assert.equal(r.values.taxExpense, 347_000);
    assert.equal(r.values.profitForPeriod, 1_031_000);
    assert.equal(r.values.basicEps, 0.04);
  });

  // Indian GAAP has no OCI statement and files only the combined EPS. Marking
  // them expected would report four concepts missing on every such filer
  // forever, which is how a "missing" list stops being read.
  it("does not expect Ind-AS-only concepts of an Indian-GAAP filer", () => {
    for (const c of [
      "otherComprehensiveIncome",
      "comprehensiveIncome",
      "shareOfProfitOfAssociates",
      "basicEpsContinuing",
    ]) {
      assert.ok(
        !r.coverage.missing.includes(c as never),
        `${c} under Indian GAAP`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Balance sheets — only ANNUAL/half-yearly filings carry one                 */
/* -------------------------------------------------------------------------- */

describe("TATACONSUM Q4 FY26 — the annual filing's balance sheet", () => {
  const r = parsed(TATACONSUM_XML);

  // An annual filing carries the Q4 column AND the full-year column, both
  // ending 2026-03-31. Taking the year would report ₹17,618 Cr of FY revenue
  // as a quarter — a 4.5x overstatement with nothing downstream to contradict
  // it, which is the legacy GLAXO trap in the new taxonomy.
  it("picks the QUARTER over the full year that shares its end date", () => {
    assert.deepEqual(
      { start: r.period.start, end: r.period.end, days: r.period.days },
      { start: "2026-01-01", end: "2026-03-31", days: 89 },
    );
    assert.deepEqual(
      r.otherPeriods.map((p) => `${p.start}..${p.end}`),
      ["2025-04-01..2026-03-31"],
    );
  });

  // The prior-year instant `PY_I` @2025-03-31 sits in the same document. A
  // balance sheet matched on "any undimensioned instant" could take it and
  // report last year's equity as this year's.
  it("takes the current instant, not the prior-year comparative", () => {
    assert.equal(r.balanceSheetDate, "2026-03-31");
    assert.equal(r.balanceSheetSource, "column");
    assert.ok(
      TATACONSUM_XML.includes("2025-03-31"),
      "fixture premise: PY_I exists",
    );
  });

  it("maps the whole Ind-AS balance sheet — the local names carry over from the legacy taxonomy", () => {
    assert.equal(r.values.totalAssets, 226_299_000_000);
    assert.equal(r.values.totalEquity, 178_048_100_000);
    assert.equal(r.values.equityShareCapital, 989_600_000);
    assert.equal(r.values.otherEquity, 177_058_500_000);
    assert.equal(r.values.currentAssets, 50_668_900_000);
    assert.equal(r.values.inventories, 19_508_300_000);
    assert.equal(r.values.tradeReceivables, 7_126_900_000);
    assert.equal(r.values.cashAndCashEquivalents, 3_572_600_000);
    assert.equal(r.values.propertyPlantAndEquipment, 10_947_100_000);
    assert.equal(r.coverage.level, "full");
    assert.deepEqual(r.coverage.byGroup.balanceSheet, {
      present: 15,
      expected: 15,
    });
  });
});

describe("DYCL Q4 FY26 — the Indian-GAAP equity side", () => {
  const r = parsed(DYCL_XML);

  // Schedule III Division I calls it Shareholders' Funds = Share Capital +
  // Reserves & Surplus. Under the Ind-AS names (`Equity`, `EquityShareCapital`,
  // `OtherEquity`) the entire equity section of every Indian-GAAP filer reads
  // as absent.
  it("maps ShareholdersFunds / ShareCapital / ReservesAndSurplus onto the canonical equity keys", () => {
    const names = elementNames(DYCL_XML);
    assert.ok(names.has("ShareholdersFunds"));
    assert.ok(names.has("ShareCapital"));
    assert.ok(names.has("ReservesAndSurplus"));
    assert.ok(!names.has("Equity"), "fixture premise: no Ind-AS Equity tag");

    assert.equal(r.values.totalEquity, 4_572_426_000);
    assert.equal(r.values.totalAssets, 6_826_552_000);
    assert.equal(r.coverage.level, "full");
  });

  // `ReservesAndSurplus` is ALSO the RBI Form-A name for a bank's reserves. If
  // both concepts kept it, one number would land in two canonical keys and
  // `coverage.present` would count a duplicate as breadth.
  it("does not also file the same number under the bank reserves concept", () => {
    assert.equal(r.values.bankReservesAndSurplus, undefined);
    assert.ok(!r.coverage.present.includes("bankReservesAndSurplus"));
    assert.equal(r.values.otherEquity, 4_087_840_000);
    // Shareholders' Funds = Share Capital + Reserves & Surplus. The identity
    // holding is what proves all three landed on the RIGHT canonical keys
    // rather than merely on some key each.
    assert.equal(
      r.values.equityShareCapital! + r.values.otherEquity!,
      r.values.totalEquity,
    );
  });

  it("keeps the current/non-current split Indian GAAP does have", () => {
    assert.notEqual(r.values.currentAssets, undefined);
    assert.notEqual(r.values.nonCurrentLiabilities, undefined);
  });
});

describe("RELIGARE Q4 FY26 — Division III has no current/non-current split", () => {
  const r = parsed(RELIGARE_XML);

  // Ind-AS Division III (the NBFC schedule) genuinely has no current /
  // non-current classification. Expecting it reports four concepts missing on
  // every NBFC annual filing forever — the same noise that made the RBI
  // concepts meaningless on NDGL.
  it("does not expect a split balance sheet of an NBFC", () => {
    for (const c of [
      "currentAssets",
      "nonCurrentAssets",
      "currentLiabilities",
      "nonCurrentLiabilities",
      "borrowingsCurrent",
      "borrowingsNonCurrent",
    ]) {
      assert.ok(!r.coverage.missing.includes(c as never), `${c} on an NBFC`);
    }
    assert.equal(r.coverage.level, "full");
    assert.deepEqual(r.coverage.byGroup.balanceSheet, {
      present: 11,
      expected: 11,
    });
  });

  it("reads the lender lines an NBFC shares with a bank", () => {
    assert.equal(r.values.totalAssets, 25_728_516_000);
    assert.equal(r.values.totalEquity, 24_669_179_000);
    assert.notEqual(r.values.borrowings, undefined);
    assert.notEqual(r.values.investments, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Mechanical completeness of the mapping                                     */
/* -------------------------------------------------------------------------- */

describe("every concept the table expects of a family is found in a real filing", () => {
  // This is the check that turns "the integrated names are the same" from an
  // assumption into a measurement. If a concept is added to `expectedIn`
  // without a local name that any real integrated document actually uses, or a
  // `capmkt` override is mistyped, the group counts stop matching and this
  // fails — instead of the concept quietly joining `coverage.missing` on every
  // filing of that family for the rest of time.
  const CASES: [string, string, ("income" | "perShare" | "balanceSheet")[]][] =
    [
      ["INFY (ind-as, quarterly)", INFY_XML, ["income", "perShare"]],
      ["CIPLA (ind-as, quarterly)", CIPLA_XML, ["income", "perShare"]],
      [
        "TATACONSUM (ind-as, annual)",
        TATACONSUM_XML,
        ["income", "perShare", "balanceSheet"],
      ],
      ["NDGL (nbfc, quarterly)", NDGL_XML, ["income", "perShare"]],
      [
        "RELIGARE (nbfc, annual)",
        RELIGARE_XML,
        ["income", "perShare", "balanceSheet"],
      ],
      ["FINOPB (banking, quarterly)", FINOPB_XML, ["income", "perShare"]],
      ["AIFL (non-ind-as, quarterly)", AIFL_XML, ["income", "perShare"]],
      [
        "DYCL (non-ind-as, annual)",
        DYCL_XML,
        ["income", "perShare", "balanceSheet"],
      ],
    ];

  for (const [label, xml, groups] of CASES) {
    it(`${label}: no expected concept is unmapped`, () => {
      const r = parsed(xml);
      for (const g of groups) {
        const { present, expected } = r.coverage.byGroup[g];
        assert.equal(
          present,
          expected,
          `${label} ${g}: ${expected - present} expected concept(s) not found — ` +
            `missing ${r.coverage.missing.join(",")}`,
        );
      }
      // A group with zero expectations would satisfy the equality vacuously.
      for (const g of groups) {
        assert.ok(
          r.coverage.byGroup[g].expected > 0,
          `${label} ${g} expects nothing`,
        );
      }
    });
  }

  // Balance-sheet concepts are absent from a QUARTERLY filing because the
  // filing has no balance sheet, not because the mapping is wrong. Stating it
  // keeps a future reader from "fixing" the expectation.
  it("a quarterly filing's balance sheet is absent by FILING, not by mapping", () => {
    const q = parsed(INFY_XML);
    assert.equal(q.coverage.byGroup.balanceSheet.present, 0);
    assert.ok(q.coverage.byGroup.balanceSheet.expected > 0);
    assert.ok(!elementNames(INFY_XML).has("Assets"));
    // …and the same taxonomy version DOES carry one when the filing does.
    assert.ok(elementNames(TATACONSUM_XML).has("Assets"));
  });
});

describe("resolveConceptTable — per-dialect, per-family lookup", () => {
  it("returns the legacy table when called the pre-MONEY-1200 way", () => {
    const legacy = resolveConceptTable("2020-03-31");
    assert.deepEqual(legacy.get("depreciationAndAmortisation"), [
      "DepreciationDepletionAndAmortisationExpense",
    ]);
  });

  it("swaps in the Indian-GAAP spelling only for that family", () => {
    const gaap = resolveConceptTable("2026-01-31", {
      dialect: "in-capmkt",
      family: "non-ind-as",
    });
    assert.deepEqual(gaap.get("depreciationAndAmortisation"), [
      "DepreciationAndAmortisationExpense",
    ]);
    const indas = resolveConceptTable("2026-01-31", {
      dialect: "in-capmkt",
      family: "ind-as",
    });
    assert.deepEqual(indas.get("depreciationAndAmortisation"), [
      "DepreciationDepletionAndAmortisationExpense",
    ]);
  });

  // An EMPTY override means "this family does not have this concept". Resolved
  // with `||` instead of `??` it would fall through to the shared list and
  // re-introduce the duplicate the DYCL case above pins.
  it("treats an empty override as 'not in this family', not as 'fall through'", () => {
    const gaap = resolveConceptTable("2026-01-31", {
      dialect: "in-capmkt",
      family: "non-ind-as",
    });
    assert.deepEqual(gaap.get("bankReservesAndSurplus"), []);
    const bank = resolveConceptTable("2026-01-31", {
      dialect: "in-capmkt",
      family: "banking",
    });
    assert.deepEqual(bank.get("bankReservesAndSurplus"), [
      "ReservesAndSurplus",
    ]);
  });

  it("ignores the family for the legacy dialect, which has no per-family names", () => {
    assert.deepEqual(
      resolveConceptTable("2020-03-31", {
        dialect: "in-bse-fin",
        family: "non-ind-as",
      }).get("depreciationAndAmortisation"),
      ["DepreciationDepletionAndAmortisationExpense"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-era regression                                                       */
/* -------------------------------------------------------------------------- */

describe("teaching the parser in-capmkt did not cost it in-bse-fin", () => {
  // The eras coexist: the backfill reads legacy filings for everything before
  // the Dec-2024 quarter. A fix that traded one for the other would empty the
  // history instead of the present, and the daily run would look healthy.
  it("legacy Ind-AS still parses, with its inferred family", () => {
    const r = parsed(GLAXO_XML);
    assert.equal(r.family, "ind-as");
    assert.equal(r.familySource, "default");
    assert.equal(r.values.revenueFromOperations, 100_005_00_000);
    assert.equal(r.values.profitForPeriod, 24_869_00_000);
    assert.equal(r.coverage.level, "full");
  });

  it("legacy banking still parses via its schemaRef, which DID name the entry point", () => {
    const r = parsed(ICICI_XML);
    assert.equal(r.family, "banking");
    assert.equal(r.familySource, "schema-ref");
    assert.equal(r.values.revenueFromOperations, 405_373_800_000);
    // Filed as a FRACTION (0.0197 = the published 1.97% GNPA), not a percent.
    assert.equal(r.values.grossNpaRatio, 0.0197);
  });

  it("parseXbrlFinancials still returns financials-or-null for existing callers", () => {
    assert.notEqual(parseXbrlFinancials(GLAXO_XML), null);
    assert.notEqual(parseXbrlFinancials(INFY_XML), null);
    assert.equal(parseXbrlFinancials("garbage"), null);
  });
});

describe("purity", () => {
  it("is deterministic across the new fixtures", () => {
    for (const xml of [INFY_XML, NDGL_XML, FINOPB_XML, AIFL_XML]) {
      assert.deepEqual(parseXbrlDocument(xml), parseXbrlDocument(xml));
    }
  });

  it("keeps no state between calls — interleaving families does not change results", () => {
    const first = parseXbrlDocument(NDGL_XML);
    parseXbrlDocument(FINOPB_XML);
    parseXbrlDocument(GOVERNANCE_XML);
    parseXbrlDocument(GLAXO_XML);
    assert.deepEqual(parseXbrlDocument(NDGL_XML), first);
  });
});

/* -------------------------------------------------------------------------- */
/* General Insurance — the entry point we RECOGNISE and refuse to parse       */
/* -------------------------------------------------------------------------- */

/**
 * MONEY-1220. `xbrl-sync-daily-prod` printed "unknown XBRL taxonomy seen — add
 * it to ENTRY_POINT_KINDS / DIALECT_PATTERNS" on 16, 17 and 18 August 2026 and
 * on every run before them. The `unknownTaxonomySamples` on the 18 Aug run named
 * exactly one thing:
 *
 *     'http://www.sebi.gov.in/xbrl/2025-01-31/in-capmkt entryPoint=IntegratedFinance_GI'
 *
 * The log line's instruction was wrong twice over. `DIALECT_PATTERNS` needed
 * nothing — `in-capmkt` was always recognised, the ENTRY POINT was not — and
 * adding a family for it is precisely what must not be done casually, because
 * `StockFinancials` carries no `source` in its key and the first write destroys
 * whatever is there to reconcile against.
 *
 * The fixture is one of the two documents that produced that log line
 * (`unknownTaxonomy: 2` — GICRE consolidated and standalone), copied
 * byte-verbatim out of the prod feed archive at
 * `gs://stockbook-content-prod/feeds/NSE/results-xbrl/2026/03/INTEGRATED_FILING_GI_1713417_13082026034943_WEB.xml`
 * (sha256 23253798…0b59). Nothing here is hand-written: a hand-written input
 * would only prove the parser agrees with itself.
 */
describe("MONEY-1220 — IntegratedFinance_GI is classified, not unknown", () => {
  const GI_XML = read("gicre-q1fy27-standalone-gi-2025-01-31.xml");

  it("resolves to `unmapped-family` with the entry point and shape named", () => {
    const o = parseXbrlDocument(GI_XML);
    assert.equal(o.kind, "unmapped-family");
    assert.ok(o.kind === "unmapped-family");
    assert.equal(o.entryPoint, "IntegratedFinance_GI");
    assert.equal(o.shape, "general-insurance");
    // The dialect was never the problem — this is the half of the log line's
    // advice that was already satisfied.
    assert.equal(o.taxonomy.dialect, "in-capmkt");
    assert.equal(o.taxonomy.version, "2025-01-31");
    assert.equal(
      o.taxonomy.namespace,
      "http://www.sebi.gov.in/xbrl/2025-01-31/in-capmkt",
    );
  });

  it("is NOT `unknown-entry-point` — that is the warning this retires", () => {
    // The whole change is this one assertion. Delete the registry entry and
    // this is the test that goes red.
    assert.notEqual(parseXbrlDocument(GI_XML).kind, "unknown-entry-point");
  });

  it("is NOT `non-financial` — the document carries real money", () => {
    // `non-financial` is documented as HEALTHY, "carries no numbers by design".
    // Retiring the warning by routing GI there would retire it with a false
    // claim, and the gap would stop being countable on the day it is closeable.
    // These are GICRE's own published Q1-FY27 standalone figures, in rupees:
    //   gross premiums written  ₹13,475.36 Cr
    //   premium earned (net)    ₹11,081.46 Cr
    //   profit before tax        ₹2,490.25 Cr
    //   profit after tax         ₹1,922.04 Cr
    assert.notEqual(parseXbrlDocument(GI_XML).kind, "non-financial");
    for (const [tag, value] of [
      ["GrossPremiumsWritten", "134753600000"],
      ["PremiumEarned", "110814600000"],
      ["ProfitOrLossBeforeTax", "24902500000"],
      ["ProfitLossAfterTax", "19220400000"],
    ] as const) {
      assert.ok(
        GI_XML.includes(`<in-capmkt:${tag} contextRef="OneD"`),
        `${tag} must be present — it is the evidence that this is a gap, not an empty filing`,
      );
      assert.ok(
        GI_XML.includes(`>${value}<`),
        `${tag} must still carry ${value}; a fixture that lost its numbers proves nothing`,
      );
    }
  });

  it("is unreadable through EVERY existing family — the reason it is unmapped", () => {
    // The measurement the decision rests on, recomputed rather than asserted in
    // prose. If a future taxonomy version made GI's names converge on the
    // ladder we already map, this is the test that would notice and this
    // decision would be worth revisiting.
    const present = elementNames(GI_XML);
    const mapped = new Set<string>();
    for (const family of ["ind-as", "banking", "nbfc", "non-ind-as"] as const) {
      for (const tags of resolveConceptTable("2025-01-31", {
        dialect: "in-capmkt",
        family,
      }).values()) {
        for (const t of tags) mapped.add(t);
      }
    }
    assert.equal(present.size, 104, "the fixture's concept count is the datum");
    assert.deepEqual(
      [...mapped].filter((t) => present.has(t)).sort(),
      ["Assets", "Investments", "OtherIncome"],
      "3 of 104, and not one of them on the income ladder",
    );

    // Stated the other way round, because this is the sentence that matters:
    // the top line and the bottom line have no mapping at all.
    for (const tag of [
      "RevenueFromOperations",
      "InterestEarned",
      "Income",
      "Expenses",
      "ProfitBeforeTax",
      "ProfitLossForPeriod",
      "ProfitLossForThePeriod",
      "TaxExpense",
    ]) {
      assert.ok(
        !present.has(tag),
        `${tag} is mapped by our table and MUST be absent here — if it appeared, ` +
          `GI would be parseable and this classification would be wrong`,
      );
    }
  });

  it("the other four entry points are untouched by the new registry arm", () => {
    // A third arm in ENTRY_POINT_KINDS is a switch every filing walks through.
    // Mis-ordering `"unmapped" in kind` against `kind.family` would silently
    // stop parsing the whole market, so the healthy path is re-asserted here.
    assert.equal(parsed(INFY_XML).family, "ind-as");
    assert.equal(parsed(NDGL_XML).family, "nbfc");
    assert.equal(parsed(FINOPB_XML).family, "banking");
    assert.equal(parsed(AIFL_XML).family, "non-ind-as");
    assert.equal(parseXbrlDocument(GOVERNANCE_XML).kind, "non-financial");
  });

  it("stays pure — same bytes, same verdict, whatever ran before it", () => {
    const first = parseXbrlDocument(GI_XML);
    parseXbrlDocument(FINOPB_XML);
    parseXbrlDocument(GOVERNANCE_XML);
    assert.deepEqual(parseXbrlDocument(GI_XML), first);
  });
});
