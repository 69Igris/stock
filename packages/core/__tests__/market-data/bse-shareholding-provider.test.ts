/**
 * BSE shareholding-pattern parsing (MONEY-1205).
 *
 * Every fixture in `__tests__/fixtures/bse-shp/` is a VERBATIM live capture
 * from `api.bseindia.com` on 2026-08-18, quarter Jun-2026 (BSE qtrid 130).
 * Nothing here is hand-written, because the defects this module exists to
 * prevent are all shapes a hand-written fixture would not think to produce:
 *
 *   ril-500325       Reliance — large cap, the full institution taxonomy,
 *                    named holders sitting under their category totals.
 *   atvpr-500028     ATV Projects — BSE-ONLY small cap, qtrid 130.01 (a
 *                    REVISED filing), `fld_quartername: null`, and NO foreign
 *                    institutions at all.
 *   hdfcbank-500180  HDFC Bank — NO promoter row whatsoever, alongside an
 *                    employee-trust line that really does report 0.
 *   vedanta-500295   Vedanta — 99.99% promoter encumbrance carrying a NULL
 *                    pledge percentage.
 *   no-filing-532532 The zero skeleton: HTTP 200, six fully-populated
 *                    all-zero category rows, no filing behind it.
 *
 * Source: packages/core/src/market-data/instruments/bse-shareholding-provider.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseBseShareholding,
  parseBseShpQuarters,
  bseShpSummaryUrl,
  bseShpPublicUrl,
  bseShpQuarterIndexUrl,
  type BseShareholdingDeps,
} from "../../src/market-data/instruments/bse-shareholding-provider";

/**
 * The REAL `normalizeQuarter` from the NSE ownership path, imported by relative
 * path on purpose.
 *
 * `packages/research` depends on `@usemoney/core`, not the reverse, so core's
 * SOURCE cannot import this — which is exactly why the provider takes it as an
 * injected dependency. The TEST can, because core's tsconfig scopes compilation
 * to `src/**` and `ownership-logic.ts` has zero imports of its own, so nothing
 * about core's build graph or its package dependencies changes. Importing the
 * genuine article is the only way to assert that BSE and NSE key a quarter
 * identically rather than merely asserting a string this file made up.
 */
import { normalizeQuarter } from "../../../research/src/data-sources/ownership-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bse-shp");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

const deps: BseShareholdingDeps = { normalizeQuarter };

const RIL = () => ({
  summary: load("ril-500325-qtr130-summary.json"),
  publicDetail: load("ril-500325-qtr130-public.json"),
});
const ATVPR = () => ({
  summary: load("atvpr-500028-qtr130.01-summary.json"),
  publicDetail: load("atvpr-500028-qtr130.01-public.json"),
});
const HDFC = () => ({
  summary: load("hdfcbank-500180-qtr130-summary.json"),
  publicDetail: load("hdfcbank-500180-qtr130-public.json"),
});

/** Non-null assert that reports which fixture failed instead of throwing TypeError. */
function must<T>(v: T | null, what: string): T {
  assert.notEqual(v, null, `${what} should have parsed`);
  return v as T;
}

describe("parseBseShareholding — real values for a known company", () => {
  it("reads Reliance's Jun-2026 summary exactly", () => {
    const r = must(parseBseShareholding(RIL(), deps), "RIL");

    assert.equal(r.scripCode, "500325");
    assert.equal(r.companyName, "Reliance Industries Ltd");
    assert.equal(r.quarter, "2026-06");
    assert.equal(r.quarterRaw, "30 Jun 2026");

    // Cross-checked against BSE's own rendered SHP page for Jun-2026.
    assert.equal(r.summary.promoterPct, 50.48);
    assert.equal(r.summary.publicPct, 49.52);
    assert.equal(r.summary.fiiPct, 17.2);
    assert.equal(r.summary.diiPct, 21.19);
  });

  it("reads the full public-shareholder breakdown", () => {
    const r = must(parseBseShareholding(RIL(), deps), "RIL");

    assert.equal(r.breakdown.mutualFundPct, 10.11);
    assert.equal(r.breakdown.insurancePct, 9.2);
    assert.equal(r.breakdown.banksFiPct, 0.05);
    assert.equal(r.breakdown.alternateInvPct, 0.19);
    assert.equal(r.breakdown.govtPct, 0.1);
    assert.equal(r.breakdown.retailPct, 7.16);

    assert.equal(r.breakdown.promoterShares, 6715496096);
    assert.equal(r.breakdown.publicShares, 6587575758);
    assert.equal(r.breakdown.totalShares, 13532538722);
    assert.equal(r.breakdown.fiiShares, 2287615325);
    assert.equal(r.breakdown.diiShares, 2818683155);
  });

  it("keeps the CATEGORY total, not the sum of its named holders", () => {
    // BSE prints "Mutual Funds/" three times for RIL: the category total
    // (10.11%, 78 holders) and the two funds disclosed above 1% — ICICI
    // Prudential 1.76% and SBI 2.62%. A parser that did not drop rows carrying
    // `Fld_ShareHolderName` would report 10.11 + 1.76 + 2.62 = 14.49.
    const r = must(parseBseShareholding(RIL(), deps), "RIL");
    assert.equal(r.breakdown.mutualFundPct, 10.11);
    assert.notEqual(r.breakdown.mutualFundPct, 14.49);

    // Same shape under "Insurance  Companies": total 9.2 with LIC's 6.88 nested.
    assert.equal(r.breakdown.insurancePct, 9.2);
  });
});

describe("parseBseShareholding — null on an unrecognised shape", () => {
  it("refuses the zero skeleton that a non-filing returns", () => {
    // THE trap this module exists for. Scrip 532532 for qtrid 130 answers
    // HTTP 200 with six category rows whose every numeric field is 0.00 — the
    // identical body a bogus scripcode (999999) and a bogus qtrid (9999)
    // return. Writing it would fabricate "promoter 0%, public 0%, pledge 0%"
    // for a company that filed nothing.
    const payload = load("no-filing-532532-qtr130-summary.json");

    // The bait is real: the rows ARE there and they ARE all zero.
    const rows = (payload as { Table1: unknown[] }).Table1;
    assert.equal(rows.length, 6, "fixture must still carry the zero skeleton");

    assert.equal(parseBseShareholding({ summary: payload }, deps), null);
  });

  it("returns null — never {} or zeros — for junk payloads", () => {
    for (const junk of [
      null,
      undefined,
      "",
      "not json",
      42,
      [],
      {},
      { summary: null },
      { summary: "nope" },
      { summary: {} },
      { summary: { Table: [], Table3: [] } },
      // Metadata present but the quarter date missing: cannot be keyed.
      { summary: { Table: [{}], Table3: [{ slongname: "X" }], Table1: [{}] } },
    ]) {
      assert.equal(
        parseBseShareholding(junk, deps),
        null,
        `expected null for ${JSON.stringify(junk)}`,
      );
    }
  });

  it("refuses when only ONE of the two metadata tables survives", () => {
    // Calling the public endpoint with `qtrid=` instead of `qtrcode=` returns
    // 200 with `Table: []` while `Table1` still populates. Half-present
    // metadata must fail closed.
    const full = load("ril-500325-qtr130-summary.json") as Record<
      string,
      unknown
    >;
    assert.equal(
      parseBseShareholding({ summary: { ...full, Table: [] } }, deps),
      null,
    );
    assert.equal(
      parseBseShareholding({ summary: { ...full, Table3: [] } }, deps),
      null,
    );
  });
});

describe("parseBseShareholding — absence is null, never 0", () => {
  it("separates a missing promoter row from a filed zero, in ONE filing", () => {
    // HDFC Bank has no promoter at all, so the filing carries NO `STA1A2` row
    // — absence. The same filing DOES carry `STC2` (employee trust) reporting
    // a genuine 0. Both in one payload, so a parser cannot pass by defaulting
    // one way or the other.
    const r = must(parseBseShareholding(HDFC(), deps), "HDFC Bank");

    assert.equal(r.summary.promoterPct, null);
    assert.notEqual(r.summary.promoterPct, 0);
    assert.equal(r.breakdown.promoterShares, null);

    assert.equal(r.summary.employeeTrustsPct, 0);
    assert.notEqual(r.summary.employeeTrustsPct, null);
  });

  it("leaves FII null for a BSE-only name with no foreign institutions", () => {
    // ATV Projects' filing has no "Sub Total" row under Institutions (Foreign)
    // — the block is absent, not zero. Its Government sub-total IS present and
    // IS 0.00 (600 shares held), so again both cases sit in one fixture.
    const r = must(parseBseShareholding(ATVPR(), deps), "ATVPR");

    assert.equal(r.summary.fiiPct, null);
    assert.equal(r.breakdown.fiiShares, null);

    assert.equal(r.breakdown.govtPct, 0);
    assert.notEqual(r.breakdown.govtPct, null);
  });

  it("does not read the zero-filled HEADER row as the institution total", () => {
    // Each institution block is preceded by a header carrying the SAME
    // `Fld_SubCategory` with `Fld_Level: null` and every figure 0. Matching on
    // subcategory alone returns the header first and reports DII/FII as 0.
    const r = must(parseBseShareholding(RIL(), deps), "RIL");
    assert.equal(r.summary.diiPct, 21.19);
    assert.equal(r.summary.fiiPct, 17.2);
    assert.notEqual(r.summary.diiPct, 0);
    assert.notEqual(r.summary.fiiPct, 0);
  });

  it("keeps institution legs null when the public leg was not fetched", () => {
    const r = must(
      parseBseShareholding({ summary: RIL().summary }, deps),
      "RIL summary-only",
    );
    assert.equal(r.summary.fiiPct, null);
    assert.equal(r.summary.diiPct, null);
    assert.equal(r.reasons.noPublicDetail, 1);
    // The summary legs still land — losing detail must not cost the rollup.
    assert.equal(r.summary.promoterPct, 50.48);
  });
});

describe("parseBseShareholding — the [0,100] shape assertion", () => {
  it("refuses a percentage that is really a share count, and says so", () => {
    // The failure this guards against is a column that silently stops being a
    // percentage — the same class as an alias pointing at the wrong field. Real
    // data never contains it, so it is induced by taking the REAL Reliance
    // fixture and putting the promoter SHARE COUNT (6,715,496,096) into the
    // promoter percentage. Without the range check that 10-digit "percentage"
    // flows straight into the model.
    const summary = load("ril-500325-qtr130-summary.json") as {
      Table1: Record<string, unknown>[];
    };
    const promoterRow = summary.Table1.find((r) => r.Fld_Code === "STA1A2");
    assert.ok(promoterRow, "fixture must carry the promoter row");
    promoterRow.Fld_TotalPercentageOf_A_B_C2 = promoterRow.Fld_TotalNoOfShares;

    const r = must(parseBseShareholding({ summary }, deps), "RIL mangled");
    assert.equal(r.summary.promoterPct, null);
    assert.ok(
      (r.reasons.pctOutOfRange ?? 0) > 0,
      "an out-of-range percentage must be counted, not silently dropped",
    );
    // The share count itself is untouched — only the percentage was rejected.
    assert.equal(r.breakdown.promoterShares, 6715496096);
  });

  it("accepts the genuine boundary values 0 and 100", () => {
    // 100 is real: HDFC Bank's public holding is exactly 100%. A range check
    // written as exclusive would drop it.
    const r = must(parseBseShareholding(HDFC(), deps), "HDFC Bank");
    assert.equal(r.summary.publicPct, 100);
    assert.equal(r.summary.employeeTrustsPct, 0);
    assert.equal(r.reasons.pctOutOfRange, undefined);
  });
});

describe("parseBseShareholding — pledge is not encumbrance", () => {
  it("reports Vedanta's 99.99% encumbrance beside its null pledge", () => {
    // `Fld_IsPledge: false` and `Fld_PledgeEncumberedPercentage: null`, while
    // NDU (5.02) + other encumbrances (94.98) total 99.99. Reporting only the
    // pledge column would describe a 99.99%-encumbered promoter as clean.
    const r = must(
      parseBseShareholding(
        { summary: load("vedanta-500295-qtr130-summary.json") },
        deps,
      ),
      "Vedanta",
    );

    assert.equal(r.summary.promoterPct, 54.72);
    assert.equal(r.summary.pledgedPct, null);
    assert.equal(r.pledgeDeclared, false);
    assert.equal(r.totalEncumberedPct, 99.99);
    assert.equal(r.reasons.encumbranceExceedsPledge, 1);
  });
});

describe("normalizeQuarter — BSE and NSE must key one quarter once", () => {
  it("produces the SAME canonical key as the NSE path, byte for byte", () => {
    const r = must(parseBseShareholding(RIL(), deps), "RIL");

    // BSE spells the quarter end "30 Jun 2026"; NSE's shareholding feed spells
    // the same day "30-Jun-2026" / "2026-06-30". All three must collapse to one
    // key or `(symbol, quarter)` splits into two rows for one filing.
    assert.equal(r.quarter, "2026-06");
    assert.equal(r.quarter, normalizeQuarter("30-Jun-2026"));
    assert.equal(r.quarter, normalizeQuarter("2026-06-30"));
    assert.equal(r.quarter, normalizeQuarter("30/06/2026"));

    // And it is the shape already stored on prod for the NSE rows.
    assert.match(r.quarter, /^\d{4}-\d{2}$/);
  });

  it("keys a REVISED filing to the same quarter as the original", () => {
    // ATV Projects' Jun-2026 was re-filed as qtrid 130.01. The revision and the
    // original must not become two rows.
    const r = must(parseBseShareholding(ATVPR(), deps), "ATVPR");
    assert.equal(r.qtrId, "130.01");
    assert.equal(r.quarter, "2026-06");
  });
});

describe("parseBseShpQuarters", () => {
  it("reads the quarter index newest-first", () => {
    const qs = must(
      parseBseShpQuarters(load("ril-500325-quarter-index.json")),
      "RIL index",
    );
    assert.equal(qs[0]?.qtrId, "130");
    assert.equal(qs[0]?.label, "June 2026");
    assert.equal(qs[0]?.status, "New");
    assert.equal(qs[1]?.qtrId, "129");
  });

  it("keeps the revision and drops the superseded filing for one quarter", () => {
    // BSE lists 130.01/June 2026/Revised immediately above 130/June 2026/New.
    // Both normalise to 2026-06, so ingesting both would have whichever came
    // last overwrite the other.
    const qs = must(
      parseBseShpQuarters(load("atvpr-500028-quarter-index.json")),
      "ATVPR index",
    );
    const june = qs.filter((q) => q.label === "June 2026");
    assert.equal(june.length, 1, "one quarter must yield one entry");
    assert.equal(june[0]?.qtrId, "130.01");
    assert.equal(june[0]?.status, "Revised");
  });

  it("keeps qtrId as a string so 130.01 survives round-tripping", () => {
    const qs = must(
      parseBseShpQuarters(load("atvpr-500028-quarter-index.json")),
      "ATVPR index",
    );
    assert.equal(typeof qs[0]?.qtrId, "string");
    assert.equal(qs[0]?.qtrId, "130.01");
  });

  it("returns null on an unrecognised envelope, [] on a scrip that never filed", () => {
    assert.equal(parseBseShpQuarters(null), null);
    assert.equal(parseBseShpQuarters("x"), null);
    assert.equal(parseBseShpQuarters({ nope: 1 }), null);
    assert.deepEqual(parseBseShpQuarters({ Table: [] }), []);
  });
});

describe("URL construction — the two endpoints spell the quarter differently", () => {
  it("uses qtrid for the summary and qtrcode for the public breakdown", () => {
    // Not cosmetic. Passing `qtrid` to the public endpoint returns 200 with
    // `Table: []`, which strips the metadata the liveness gate depends on.
    assert.match(bseShpSummaryUrl("500325", "130"), /[?&]qtrid=130(&|$)/);
    assert.match(bseShpPublicUrl("500325", "130"), /[?&]qtrcode=130(&|$)/);
    assert.doesNotMatch(bseShpPublicUrl("500325", "130"), /[?&]qtrid=/);
    assert.doesNotMatch(bseShpSummaryUrl("500325", "130"), /[?&]qtrcode=/);
  });

  it("targets the host and routes recovered from BSE's bundle", () => {
    for (const url of [
      bseShpQuarterIndexUrl("500325"),
      bseShpSummaryUrl("500325", "130"),
      bseShpPublicUrl("500325", "130"),
    ]) {
      assert.ok(url.startsWith("https://api.bseindia.com/BseIndiaAPI/api/"));
    }
    assert.match(bseShpQuarterIndexUrl("500325"), /\/SHPQNewFormat\/w\?/);
    assert.match(
      bseShpSummaryUrl("500325", "130"),
      /\/CorporatesSHPSecuritybeta\/w\?/,
    );
    assert.match(
      bseShpPublicUrl("500325", "130"),
      /\/Corp_shpSec_SHPPubShold_ng\/w\?/,
    );
  });

  it("escapes the scrip code and quarter handle", () => {
    assert.match(bseShpSummaryUrl("50 0325", "1&30"), /scripcode=50%200325/);
    assert.match(bseShpSummaryUrl("50 0325", "1&30"), /qtrid=1%2630/);
  });
});

describe("raw + reasons", () => {
  it("stringifies the source payload for the audit column", () => {
    const r = must(parseBseShareholding(RIL(), deps), "RIL");
    const round = JSON.parse(r.raw) as {
      summary: { Table3: [{ nscripcode: number }] };
    };
    assert.equal(round.summary.Table3[0].nscripcode, 500325);
  });

  it("tallies reasons instead of failing silently", () => {
    const r = must(parseBseShareholding(RIL(), deps), "RIL");
    assert.equal(typeof r.reasons, "object");
    // The Non-Institutions sub-total has no column of its own; it is counted so
    // a taxonomy change shows up rather than vanishing.
    assert.equal(r.reasons.subTotalNonInstitutions, 1);
    assert.equal(r.reasons.pctOutOfRange, undefined);
  });
});
