/**
 * AMFI fund metadata — parser + join tests (MONEY-1205 W3-C).
 *
 * Every fixture in `__tests__/fixtures/amfi-metadata/` is BYTES AMFI SERVED,
 * captured 2026-08-18, unedited. They are narrow queries against the same live
 * endpoints the production fetchers call — `?mf=64`, `MF_ID=64`, `MF_ID=62` —
 * not trimmed or hand-built files, so a shape assertion here is an assertion
 * about the real feed:
 *
 *   scheme-master-ppfas.csv                 DownloadSchemeData_Po.aspx?mf=64
 *   scheme-master-mf62.csv                  DownloadSchemeData_Po.aspx?mf=62
 *   scheme-master-empty-mf1.csv             DownloadSchemeData_Po.aspx?mf=1   (trap: 200 + header only)
 *   aaum-schemewise-ppfas-2026q1.json       average-aum-schemewise MF_ID=64
 *   aaum-schemewise-mf62-2026q1.json        average-aum-schemewise MF_ID=62
 *   ter-ppfas-2026-07.xlsx                  populate-te-rdata-revised MF_ID=64 Month=07-2026
 *   ter-mf62-2026-07.xlsx                   populate-te-rdata-revised MF_ID=62 Month=07-2026
 *   ter-mf62-2023-07-legacy-headers.xlsx    ... Month=07-2023 (pre-2026 column set)
 *   ter-empty-2015-01.xlsx                  ... Month=01-2015 (trap: 200 + valid header, 0 rows)
 *
 * The numbers asserted are independently checkable outside this repo: Parag
 * Parikh Flexi Cap Fund's launch date (13-May-2013), its direct/regular TER
 * (0.69% / 1.30%) and its quarterly AAUM (~Rs 93,775 cr direct-growth,
 * ~Rs 46,832 cr regular-growth against a widely reported ~Rs 1.4 lakh crore
 * fund) all appear in PPFAS's own disclosures.
 *
 * No test here touches the network or a clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AAUM_LAKH_PER_CRORE,
  AMFI_METADATA_PROVIDER_ID,
  AmfiFeedEmptyError,
  amfiAaumFinancialYearLabel,
  amfiAaumQuarterLabel,
  amfiFundMetadataProvider,
  amfiFundTypeFromCategory,
  amfiTerMonthToken,
  buildAmfiFundMetadataIndex,
  buildAmfiSchemeMasterUrl,
  buildAmfiTerExcelUrl,
  classifyAmfiPlan,
  isAmfiFundMetadataEnabled,
  parseAmfiAumDisclosure,
  parseAmfiDayMonthYear,
  parseAmfiSchemeMaster,
  parseAmfiTerDisclosure,
  primeAmfiFundMetadataSnapshot,
  resetAmfiFundMetadataSnapshot,
  splitJammedIsins,
  type AmfiAumDisclosure,
  type AmfiSchemeMasterFile,
  type AmfiTerDisclosure,
} from "../../src/market-data/instruments/amfi-fund-metadata-provider";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "amfi-metadata");
const bytes = (name: string): Uint8Array => readFileSync(join(FIXTURES, name));

/** Parse-or-fail helper: these fixtures MUST be recognised, so a null is a bug. */
function must<T>(value: T | null, what: string): T {
  assert.ok(
    value !== null,
    `${what} must parse — a null here means the fixture shape changed`,
  );
  return value as T;
}

const ppfasMaster = (): AmfiSchemeMasterFile =>
  must(
    parseAmfiSchemeMaster(bytes("scheme-master-ppfas.csv")),
    "PPFAS scheme master",
  );
const ppfasTer = (): AmfiTerDisclosure =>
  must(parseAmfiTerDisclosure(bytes("ter-ppfas-2026-07.xlsx")), "PPFAS TER");
const ppfasAum = (): AmfiAumDisclosure =>
  must(
    parseAmfiAumDisclosure(bytes("aaum-schemewise-ppfas-2026q1.json")),
    "PPFAS AAUM",
  );

// ══════════════════════════════════════════════════════════════════════════
// URL + period tokens
// ══════════════════════════════════════════════════════════════════════════

test("URL builders produce the doors that were probed live", () => {
  assert.equal(
    buildAmfiSchemeMasterUrl(),
    "https://portal.amfiindia.com/DownloadSchemeData_Po.aspx?mf=0",
  );
  assert.equal(
    buildAmfiTerExcelUrl("07-2026"),
    "https://www.amfiindia.com/api/populate-te-rdata-revised" +
      "?MF_ID=All&Month=07-2026&strCat=-1&strType=-1&excel=true",
  );
});

test("TER month token is the absolute MM-YYYY the door validates", () => {
  assert.equal(amfiTerMonthToken(new Date(Date.UTC(2026, 6, 15))), "07-2026");
  // Zero-padding is not cosmetic: an unpadded "7-2026" is rejected 400 by AMFI
  // with "Month must be in valid format MM-YYYY".
  assert.equal(amfiTerMonthToken(new Date(Date.UTC(2026, 0, 1))), "01-2026");
});

test("AAUM labels: the quarter carries its own calendar year, not the FY's", () => {
  assert.equal(
    amfiAaumQuarterLabel(new Date(Date.UTC(2026, 4, 9))),
    "April - June 2026",
  );
  assert.equal(
    amfiAaumQuarterLabel(new Date(Date.UTC(2026, 1, 9))),
    "January - March 2026",
  );
  assert.equal(
    amfiAaumQuarterLabel(new Date(Date.UTC(2025, 8, 9))),
    "July - September 2025",
  );
  // ...while that Jan-Mar 2026 quarter lives inside FY 2025-26. Getting this
  // pairing wrong resolves to a valid-but-different quarter with no error.
  assert.equal(
    amfiAaumFinancialYearLabel(new Date(Date.UTC(2026, 1, 9))),
    "April 2025 - March 2026",
  );
  assert.equal(
    amfiAaumFinancialYearLabel(new Date(Date.UTC(2026, 4, 9))),
    "April 2026 - March 2027",
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Date parsing
// ══════════════════════════════════════════════════════════════════════════

test("DD-Mon-YYYY parses to UTC midnight, and rejects impossible days", () => {
  const d = parseAmfiDayMonthYear("13-May-2013");
  assert.ok(d);
  assert.equal(d.toISOString(), "2013-05-13T00:00:00.000Z");
  // Built from parts on purpose: `new Date("13-May-2013")` lands in the
  // runner's local zone, so an IST worker would store 2013-05-12T18:30:00Z.
  assert.equal(d.getUTCHours(), 0);

  assert.equal(parseAmfiDayMonthYear("31-Feb-2026"), null);
  assert.equal(parseAmfiDayMonthYear(""), null);
  assert.equal(parseAmfiDayMonthYear("TER Date"), null);
  assert.equal(parseAmfiDayMonthYear("2026-07-31"), null);
});

// ══════════════════════════════════════════════════════════════════════════
// Scheme master
// ══════════════════════════════════════════════════════════════════════════

test("scheme master parses AMFI's real CSV and carries the launch date", () => {
  const file = ppfasMaster();
  assert.equal(file.rows.length, 28);
  assert.equal(file.reasons.ok, 28);

  const flexi = file.rows.find((r) => r.schemeCode === "122639");
  assert.ok(
    flexi,
    "AMFI code 122639 = Parag Parikh Flexi Cap Fund Direct Growth",
  );
  assert.equal(flexi.schemeName, "Parag Parikh Flexi Cap Fund");
  assert.equal(
    flexi.schemeNavName,
    "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
  );
  assert.equal(flexi.plan, "DIRECT");
  assert.equal(flexi.schemeCategory, "Equity Scheme - Flexi Cap Fund");
  // 13-May-2013 is the fund's published inception date.
  assert.equal(flexi.launchDate?.toISOString(), "2013-05-13T00:00:00.000Z");
});

test("the jammed ISIN column splits on width and on the '-' sentinel", () => {
  // Two 12-char ISINs with NO separator — the header itself is glued:
  // "ISIN Div Payout/ ISIN GrowthISIN Div Reinvestment".
  assert.deepEqual(splitJammedIsins("INF209K01157INF209K01CE5"), {
    payoutOrGrowth: "INF209K01157",
    reinvestment: "INF209K01CE5",
  });
  assert.deepEqual(splitJammedIsins("INF579M01183"), {
    payoutOrGrowth: "INF579M01183",
    reinvestment: null,
  });
  // 43 live rows use a bare "-" for the missing half, on either side.
  assert.deepEqual(splitJammedIsins("INF204K01B81-"), {
    payoutOrGrowth: "INF204K01B81",
    reinvestment: null,
  });
  assert.deepEqual(splitJammedIsins("-INF109KC1MY5"), {
    payoutOrGrowth: null,
    reinvestment: "INF109KC1MY5",
  });
  assert.deepEqual(splitJammedIsins(""), {
    payoutOrGrowth: null,
    reinvestment: null,
  });
  // A half-read ISIN joins to the wrong fund as confidently as a whole one, so
  // anything that is not INF + 9 alphanumerics is discarded, not stored.
  assert.deepEqual(splitJammedIsins("NOTANISIN123"), {
    payoutOrGrowth: null,
    reinvestment: null,
  });

  const isins = ppfasMaster().rows.find((r) => r.schemeCode === "122639");
  assert.ok(isins?.isinPayoutOrGrowth?.startsWith("INF"));
});

test("plan comes only from a NAV name that DECLARES one", () => {
  assert.equal(
    classifyAmfiPlan("Parag Parikh Flexi Cap Fund - Direct Plan - Growth"),
    "DIRECT",
  );
  assert.equal(
    classifyAmfiPlan("Parag Parikh Flexi Cap Fund - Regular Plan - Growth"),
    "REGULAR",
  );
  // 4,470 of 16,394 live master rows (27%) name neither — legacy pre-2013
  // schemes and Institutional/Retail share classes. "No Direct means Regular"
  // is the industry convention AND a guess; a wrong plan silently attaches the
  // wrong expense ratio to a fund.
  assert.equal(
    classifyAmfiPlan("Aditya Birla Sun Life Liquid Fund -Retail - IDCW"),
    null,
  );
  assert.equal(classifyAmfiPlan("360 ONE Gold ETF"), null);
  // 44 live rows name both, which is equally undecidable.
  assert.equal(classifyAmfiPlan("Some Fund - Regular and Direct Plan"), null);
});

test("scheme master: unrecognised bytes yield null, a dataless file THROWS", () => {
  // Not this file at all -> null, so a caller can refuse and stay un-checkpointed.
  assert.equal(parseAmfiSchemeMaster("hello,world"), null);
  assert.equal(parseAmfiSchemeMaster(""), null);

  // `?mf=1` is a valid-looking AMC id that answers 200 with 164 bytes: the
  // correct 10-column header and zero data rows. Returning `{rows: []}` here is
  // exactly the silent success this ticket exists to remove.
  assert.throws(
    () => parseAmfiSchemeMaster(bytes("scheme-master-empty-mf1.csv")),
    (err: unknown) => {
      assert.ok(err instanceof AmfiFeedEmptyError);
      assert.equal(err.feed, "scheme-master");
      return true;
    },
  );
});

test("fundType maps only AMFI's modern SEBI buckets, never the legacy labels", () => {
  assert.equal(
    amfiFundTypeFromCategory("Equity Scheme - Flexi Cap Fund"),
    "equity",
  );
  assert.equal(amfiFundTypeFromCategory("Debt Scheme - Dynamic Bond"), "debt");
  assert.equal(
    amfiFundTypeFromCategory("Hybrid Scheme - Balanced Hybrid Fund"),
    "hybrid",
  );
  assert.equal(
    amfiFundTypeFromCategory("Solution Oriented Scheme - Retirement Fund"),
    "solution",
  );
  assert.equal(amfiFundTypeFromCategory("Other Scheme - Gold ETF"), "other");
  // Pre-2018 labels still in the live master: 6,084 rows say "Income", 357 say
  // "Growth", 5 say "Balanced". Their modern equivalent is a judgement per
  // scheme, so they stay null rather than becoming a plausible-looking guess.
  assert.equal(amfiFundTypeFromCategory("Income"), null);
  assert.equal(amfiFundTypeFromCategory("Growth"), null);
  assert.equal(amfiFundTypeFromCategory("Balanced"), null);
  assert.equal(amfiFundTypeFromCategory(""), null);
});

// ══════════════════════════════════════════════════════════════════════════
// TER
// ══════════════════════════════════════════════════════════════════════════

test("TER: real published values, one row per scheme, latest date wins", () => {
  const file = ppfasTer();
  // 7 schemes out of 217 raw daily rows.
  assert.equal(file.rows.length, 7);

  const flexi = file.rows.find(
    (r) => r.schemeName === "Parag Parikh Flexi Cap Fund",
  );
  assert.ok(flexi);
  // PPFAS's own disclosure for July 2026: regular 1.30%, direct 0.69%.
  assert.equal(flexi.regularTer, 1.3);
  assert.equal(flexi.directTer, 0.69);
  // The export is DAILY inside a monthly file; the rate in force at month end
  // is the only one a "current expense ratio" field can honestly hold.
  assert.equal(flexi.terDate.toISOString(), "2026-07-31T00:00:00.000Z");

  for (const row of file.rows) {
    assert.equal(row.terDate.toISOString(), "2026-07-31T00:00:00.000Z");
  }
});

test("TER: a real 0.00% survives as 0, NOT as null", () => {
  // This is the exact bug being replaced. The old writer used
  // `parseFloat(x) || null`, which cannot tell a genuine zero from an
  // unparseable value — so every zero-TER plan was stored as "unknown".
  const file = must(
    parseAmfiTerDisclosure(bytes("ter-mf62-2026-07.xlsx")),
    "360 ONE TER",
  );
  const gold = file.rows.find((r) => r.schemeName === "360 ONE GOLD ETF");
  assert.ok(gold);
  assert.equal(gold.directTer, 0);
  assert.notEqual(gold.directTer, null);
  assert.equal(gold.regularTer, 0.47);

  // Not a lone oddity: 3 of the 12 schemes in this file publish a zero direct TER.
  const zeros = file.rows.filter((r) => r.directTer === 0);
  assert.equal(zeros.length, 3);
});

test("TER: the 13-row disclaimer block below the data is dropped", () => {
  const file = must(
    parseAmfiTerDisclosure(bytes("ter-mf62-2026-07.xlsx")),
    "360 ONE TER",
  );
  // AMFI appends a "Disclaimer :" / "Reference period:" block, all in column A.
  assert.equal(file.reasons.blank_scheme_name, 13);
  for (const row of file.rows) {
    assert.doesNotMatch(
      row.schemeName,
      /disclaimer|reference period|regulation/i,
    );
  }
});

test("TER: the pre-2026 header regime still parses (columns matched by name)", () => {
  // July 2023 publishes "Base TER / Additional expense as per Regulation
  // 52(6A)(b) / (c) / GST"; July 2026 publishes "Base Expense Ratio (BER) /
  // Brokerage cost / Transaction Cost / Statutory Levies". Only
  // "... - Total TER (%)" is common, which is why only the four needed columns
  // are required and they are located by header TEXT, not position.
  const file = must(
    parseAmfiTerDisclosure(bytes("ter-mf62-2023-07-legacy-headers.xlsx")),
    "legacy-header TER",
  );
  assert.ok(file.rows.length > 0);
  const bond = file.rows.find((r) =>
    /360 ONE Dynamic Bond Fund/i.test(r.schemeName),
  );
  assert.ok(bond);
  assert.equal(bond.regularTer, 0.52);
  assert.equal(bond.directTer, 0.27);
  assert.equal(bond.terDate.toISOString(), "2023-07-31T00:00:00.000Z");
});

test("TER: unrecognised bytes yield null, a dataless workbook THROWS", () => {
  assert.equal(
    parseAmfiTerDisclosure(new TextEncoder().encode("not a workbook")),
    null,
  );
  assert.equal(parseAmfiTerDisclosure(new Uint8Array(0)), null);

  // `Month=01-2015` returns HTTP 200, the right content type, the right sheet
  // name (`TER_Revised`), a valid header row and a disclaimer block — and zero
  // data rows. A provider that reported success on this is the whole defect.
  assert.throws(
    () => parseAmfiTerDisclosure(bytes("ter-empty-2015-01.xlsx")),
    (err: unknown) => {
      assert.ok(
        err instanceof AmfiFeedEmptyError,
        "must be the loud-failure type",
      );
      assert.equal(err.feed, "ter");
      assert.match(err.message, /0 usable rows/);
      // The per-file tally survives the throw, so nothing diagnostic is lost.
      assert.equal(err.reasons.blank_scheme_name, 13);
      return true;
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// AAUM
// ══════════════════════════════════════════════════════════════════════════

test("AAUM: values are rupee LAKH on the wire and rupee CRORE on the way out", () => {
  const file = ppfasAum();
  assert.equal(file.period, "April - June 2026");
  assert.equal(file.rows.length, 28);

  const direct = file.rows.find((r) => r.schemeCode === "122639");
  assert.ok(direct, "AMFI code 122639 = Parag Parikh Flexi Cap Direct Growth");
  // Wire value 9,377,503.70 LAKH. Nothing in the payload says which unit it is.
  assert.equal(direct.aumCrore * AAUM_LAKH_PER_CRORE, 9377503.7);
  // = Rs 93,775 crore, against a fund whose total across plans is widely
  // reported at ~Rs 1.4 lakh crore. Read as crore it would be Rs 9.4 million
  // crore — larger than the entire Indian mutual fund industry, and nothing
  // anywhere would throw.
  assert.ok(Math.abs(direct.aumCrore - 93775.037) < 1e-6);
  assert.ok(direct.aumCrore > 50_000 && direct.aumCrore < 200_000);

  const regular = file.rows.find((r) => r.schemeCode === "122640");
  assert.ok(regular);
  assert.ok(Math.abs(regular.aumCrore - 46831.6577) < 1e-6);

  // AAUM is keyed by AMFI_Code, i.e. per plan AND option — so it needs no plan
  // inference at all. Direct-Growth and Direct-IDCW are different numbers.
  const directIdcw = file.rows.find((r) => r.schemeCode === "153964");
  assert.ok(directIdcw);
  assert.ok(Math.abs(directIdcw.aumCrore - 28.9271) < 1e-6);
});

test("AAUM: the echoed period is checked, because fyId/periodId RENUMBER", () => {
  const raw = bytes("aaum-schemewise-ppfas-2026q1.json");
  // `fyId=1&periodId=1` meant Apr-Jun 2026 on 2026-08-18 and will mean
  // Jul-Sep 2026 the moment that quarter publishes; `fyId=1` becomes FY2027-28
  // next April. Asking by ordinal and trusting the answer reads a different
  // quarter every time, silently. So the payload must say what we asked for.
  assert.ok(parseAmfiAumDisclosure(raw, "April - June 2026"));
  assert.equal(parseAmfiAumDisclosure(raw, "July - September 2026"), null);
});

test("AAUM: unrecognised bodies yield null, a dataless payload THROWS", () => {
  assert.equal(parseAmfiAumDisclosure("not json"), null);
  assert.equal(parseAmfiAumDisclosure("[]"), null);
  // What AMFI actually returns (HTTP 400) for a bogus fyId or MF_ID.
  assert.equal(
    parseAmfiAumDisclosure(
      JSON.stringify({
        message: "Cannot read properties of undefined (reading 'find')",
      }),
    ),
    null,
  );

  // Synthetic, deliberately: AMFI 400s on the inputs that would produce this,
  // so no captured bytes exist. The envelope is the real one; only the emptiness
  // is constructed.
  assert.throws(
    () =>
      parseAmfiAumDisclosure(
        JSON.stringify({ data: [], selectedPeriod: "April - June 2026" }),
      ),
    AmfiFeedEmptyError,
  );
  assert.throws(
    () =>
      parseAmfiAumDisclosure(
        JSON.stringify({
          data: [{ Mfname: "X", SchemeCat_Desc: "Y", schemes: [] }],
          selectedPeriod: "April - June 2026",
        }),
      ),
    AmfiFeedEmptyError,
  );
});

test("AAUM: absence is null, but a published 0 is a real 0", () => {
  const envelope = (excl: unknown, fof: unknown): string =>
    JSON.stringify({
      selectedPeriod: "April - June 2026",
      data: [
        {
          Mfname: "Test MF",
          SchemeCat_Desc: "Equity Scheme - Flexi Cap Fund",
          schemes: [
            {
              SchemeNAVName: "Test Fund",
              AMFI_Code: 999999,
              AverageAumForTheMonth: {
                ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas:
                  excl,
                FundOfFundsDomestic: fof,
              },
            },
          ],
        },
      ],
    });

  // A real zero AAUM must survive as 0 — the same rule as the TER zero.
  const zero = must(parseAmfiAumDisclosure(envelope(0, 0)), "zero AAUM");
  assert.equal(zero.rows[0]?.aumCrore, 0);

  // Blank on BOTH halves is "no number", which is not zero. It drops the row
  // rather than writing 0 crore over a fund's real size.
  assert.throws(
    () => parseAmfiAumDisclosure(envelope("", "")),
    AmfiFeedEmptyError,
  );
  assert.throws(
    () => parseAmfiAumDisclosure(envelope("-", null)),
    AmfiFeedEmptyError,
  );

  // One half present is enough; SEBI's split is (everything-but-domestic-FoF)
  // + (domestic FoF) and the fund's AUM is the sum.
  const half = must(parseAmfiAumDisclosure(envelope(500, "")), "half AAUM");
  assert.equal(half.rows[0]?.aumCrore, 5);
});

// ══════════════════════════════════════════════════════════════════════════
// Join
// ══════════════════════════════════════════════════════════════════════════

test("join: one TER name fans out to four codes and resolves per PLAN", () => {
  const index = buildAmfiFundMetadataIndex({
    master: ppfasMaster(),
    aum: ppfasAum(),
    ter: ppfasTer(),
  });

  // "Parag Parikh Flexi Cap Fund" is ONE TER row and FOUR scheme codes
  // (Direct/Regular x Growth/IDCW). AMFI publishes TER per PLAN, so the fan-out
  // resolves exactly: direct codes take D_TER, regular codes take R_TER, and
  // the option (Growth vs IDCW) does not affect TER at all.
  const directGrowth = index.bySchemeCode.get("122639");
  const regularGrowth = index.bySchemeCode.get("122640");
  const directIdcw = index.bySchemeCode.get("153964");
  const regularIdcw = index.bySchemeCode.get("153965");
  assert.ok(directGrowth && regularGrowth && directIdcw && regularIdcw);

  assert.equal(directGrowth.expenseRatio, 0.69);
  assert.equal(directIdcw.expenseRatio, 0.69);
  assert.equal(regularGrowth.expenseRatio, 1.3);
  assert.equal(regularIdcw.expenseRatio, 1.3);

  // AUM is per code, so all four differ — no plan reasoning was involved.
  assert.ok(Math.abs((directGrowth.aum ?? 0) - 93775.037) < 1e-6);
  assert.ok(Math.abs((regularGrowth.aum ?? 0) - 46831.6577) < 1e-6);
  assert.ok(Math.abs((directIdcw.aum ?? 0) - 28.9271) < 1e-6);

  // Launch date and fundType come from the master, identically for all four.
  for (const f of [directGrowth, regularGrowth, directIdcw, regularIdcw]) {
    assert.equal(f.launchDate?.toISOString(), "2013-05-13T00:00:00.000Z");
    assert.equal(f.fundType, "equity");
  }
});

test("join: a code whose plan is undeclared gets NO expense ratio", () => {
  // 360 ONE's three ETFs have no plan token in their NAV names (an ETF has no
  // Direct/Regular split), yet AMFI still publishes both TER columns for them.
  // Picking one would be guessing a plan.
  const index = buildAmfiFundMetadataIndex({
    master: must(
      parseAmfiSchemeMaster(bytes("scheme-master-mf62.csv")),
      "360 ONE master",
    ),
    aum: must(
      parseAmfiAumDisclosure(bytes("aaum-schemewise-mf62-2026q1.json")),
      "360 ONE AAUM",
    ),
    ter: must(
      parseAmfiTerDisclosure(bytes("ter-mf62-2026-07.xlsx")),
      "360 ONE TER",
    ),
  });

  assert.equal(index.stats.terPlanUndeclared, 3);
  for (const code of ["153357", "153415", "154366"]) {
    const f = index.bySchemeCode.get(code);
    assert.ok(
      f,
      `${code} must still be indexed — AUM and launch date do not need a plan`,
    );
    assert.equal(
      f.expenseRatio,
      null,
      `${code} must NOT be given a guessed plan's TER`,
    );
    assert.notEqual(f.aum, null);
    assert.notEqual(f.launchDate, null);
  }
  assert.equal(index.stats.withExpenseRatio, 42);
  assert.equal(index.stats.covered, 45);
});

test("join: AMFI publishes none of the SID/riskometer/returns fields", () => {
  const index = buildAmfiFundMetadataIndex({
    master: ppfasMaster(),
    aum: ppfasAum(),
    ter: ppfasTer(),
  });
  const f = index.bySchemeCode.get("122639");
  assert.ok(f);
  // These live in each AMC's Scheme Information Document / factsheet, or behind
  // the CRISIL-hosted iframe AMFI embeds for fund performance. Filling them
  // from anything here would be invention — and MONEY-610 already had to remove
  // a fabricated "Nifty 50 TRI" benchmark from this product once.
  assert.equal(f.benchmarkName, null);
  assert.equal(f.fundManager, null);
  assert.equal(f.exitLoad, null);
  assert.equal(f.riskLevel, null);
  assert.equal(f.crisilRating, null);
  assert.equal(f.volatility, null);
  assert.equal(f.returns1Y, null);
  assert.equal(f.returns3Y, null);
  assert.equal(f.returns5Y, null);
  assert.equal(f.returnsInception, null);
});

test("join: a fold that covers nothing THROWS rather than reporting success", () => {
  // Every input is individually non-empty and they still join to nothing —
  // a TER month for one AMC against a master for another. A run that logged
  // success here is precisely the 5.5-month silent failure being fixed.
  const master = ppfasMaster();
  const emptyish: AmfiSchemeMasterFile = {
    rows: master.rows.map((r) => ({
      ...r,
      launchDate: null,
      schemeCategory: "Income", // legacy label -> fundType null
      schemeName: `NOT ${r.schemeName}`,
    })),
    reasons: {},
  };
  assert.throws(
    () =>
      buildAmfiFundMetadataIndex({
        master: emptyish,
        aum: null,
        ter: ppfasTer(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof AmfiFeedEmptyError);
      assert.equal(err.feed, "index");
      return true;
    },
  );
});

test("join: works on the master alone when AUM and TER did not publish", () => {
  const index = buildAmfiFundMetadataIndex({ master: ppfasMaster() });
  assert.equal(index.stats.withLaunchDate, 28);
  assert.equal(index.stats.withAum, 0);
  assert.equal(index.stats.withExpenseRatio, 0);
  assert.ok(index.stats.covered > 0);
});

// ══════════════════════════════════════════════════════════════════════════
// Provider seam
// ══════════════════════════════════════════════════════════════════════════

test("provider: off unless MF_METADATA_PROVIDER names it", () => {
  const before = process.env.MF_METADATA_PROVIDER;
  try {
    delete process.env.MF_METADATA_PROVIDER;
    assert.equal(isAmfiFundMetadataEnabled(), false);
    assert.equal(amfiFundMetadataProvider.isConfigured(), false);

    process.env.MF_METADATA_PROVIDER = "kuvera";
    assert.equal(amfiFundMetadataProvider.isConfigured(), false);

    process.env.MF_METADATA_PROVIDER = "  AMFI  ";
    assert.equal(amfiFundMetadataProvider.isConfigured(), true);
    assert.equal(amfiFundMetadataProvider.id, AMFI_METADATA_PROVIDER_ID);
  } finally {
    if (before === undefined) delete process.env.MF_METADATA_PROVIDER;
    else process.env.MF_METADATA_PROVIDER = before;
  }
});

test("provider: hit returns a COPY, miss returns not-found (never unavailable)", async () => {
  const index = buildAmfiFundMetadataIndex({
    master: ppfasMaster(),
    aum: ppfasAum(),
    ter: ppfasTer(),
  });
  primeAmfiFundMetadataSnapshot(index);
  try {
    const hit = await amfiFundMetadataProvider.fetch({
      schemeCode: "122639",
      isinGrowth: null,
      isinDividend: null,
      schemeName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
      amcName: "PPFAS Mutual Fund",
    });
    assert.equal(hit.status, "ok");
    assert.ok(hit.status === "ok");
    assert.equal(hit.fields.expenseRatio, 0.69);

    // The snapshot is shared by every lookup in a 500-fund batch. Handing out
    // the stored object would let one caller's mutation poison every later read
    // of that scheme.
    hit.fields.expenseRatio = 99;
    assert.equal(index.bySchemeCode.get("122639")?.expenseRatio, 0.69);

    // A scheme absent from a snapshot that DID load is a deterministic answer —
    // "AMFI does not disclose this fund" — and must advance the cursor.
    // `unavailable` is reserved for a snapshot that could not be built.
    const miss = await amfiFundMetadataProvider.fetch({
      schemeCode: "000000",
      isinGrowth: null,
      isinDividend: null,
      schemeName: "Nonexistent Fund",
      amcName: "Nobody",
    });
    assert.equal(miss.status, "not-found");
  } finally {
    resetAmfiFundMetadataSnapshot();
  }
});
