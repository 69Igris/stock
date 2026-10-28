/**
 * BSE results XBRL — the index seam and the real instances (MONEY-1255).
 *
 * ## What this file is defending
 *
 * Two independent things, and they fail in opposite directions.
 *
 * 1. **The URL workaround.** BSE's `Result_Arch_ng` index points integrated-era
 *    NBFC filings at `/XBRLFILES/NBFCUploadDocument/…`, and those 404. The
 *    files are in the sibling `IFNBFCUploadDocument`. Measured across three
 *    NBFCs (512437 Apollo Finvest, 539773 Advik Capital, 530127 NPR Finance)
 *    and both in-capmkt versions: every such URL 404s, every one resolves under
 *    the sibling. The rewrite is narrow ON PURPOSE — the SAME directory's
 *    legacy `NBFC_*` files serve perfectly well, so a directory-wide rewrite
 *    would turn working URLs into 404s. Both halves of the matcher are
 *    asserted, because only one of them failing is silent.
 *
 * 2. **The parser needs nothing new.** BSE's results are filed in the two
 *    taxonomy families this repo already dispatches on — `in-bse-fin` is
 *    literally a `bseindia.com`-hosted namespace and `in-capmkt` is SEBI's. The
 *    fixtures here are REAL BSE instances fetched from BSE, so "the parser
 *    already handles BSE" is a measurement rather than an inference from the
 *    namespace string.
 *
 * ## The identity trap these fixtures exist to pin
 *
 * A BSE-only issuer does not OMIT its symbol. It files
 * `<in-capmkt:Symbol>NOTLISTED</in-capmkt:Symbol>` — a literal sentinel. Since
 * `XbrlFiling`'s unique key is
 * `symbol + exchange + periodEnd + periodType + basis + cumulative`, a writer
 * that trusts a non-empty symbol collapses EVERY BSE-only issuer for a given
 * quarter and basis onto one row, where they overwrite each other. That is a
 * cross-company data merge that presents as a working ingest with a low row
 * count. The fixtures cover both sides: RELIANCE states a real symbol, Apollo
 * Finvest states the sentinel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bseInstanceUrlCandidates,
  buildResultsIndexPath,
  filingExchange,
  parseXbrlDocument,
  RESULTS_INSTANCE_HOST,
} from "../../src/market-data/index";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl");
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

/** The real BSE instances, all fetched from `www.bseindia.com`. */
const FIXTURE_NAMES = {
  /** in-capmkt 2025-01-31, IntegratedFinance_NBFC. Symbol = "NOTLISTED". */
  nbfcSentinel: "bse-apollofin-h1fy26-standalone-nbfc-2025-01-31.xml",
  /** in-bse-fin 2018-03-31 — a BSE-HOSTED namespace. No Symbol element. */
  legacyBseFin: "bse-nprfin-q4fy19-standalone-nonbanking-2018-03-31.xml",
  /** in-capmkt 2026-01-31, IntegratedFinance_IndAS. Symbol = "RELIANCE". */
  dualListed: "bse-reliance-q1fy27-consolidated-indas-2026-01-31.xml",
} as const;

describe("bseInstanceUrlCandidates — the IFNBFC workaround", () => {
  const BROKEN =
    "/XBRLFILES/NBFCUploadDocument/Integrated_Finance_NBFC_530127_1282026191518.xml";

  it("offers the indexed URL FIRST, then the rewrite", () => {
    const out = bseInstanceUrlCandidates(BROKEN);
    assert.equal(out.length, 2, "expected a primary and one fallback");
    assert.equal(
      out[0],
      `${RESULTS_INSTANCE_HOST.BSE}${BROKEN}`,
      "the indexed URL must be tried first — trying the rewrite first would " +
        "hide the day BSE fixes its index",
    );
    assert.equal(
      out[1],
      `${RESULTS_INSTANCE_HOST.BSE}/XBRLFILES/IFNBFCUploadDocument/` +
        "Integrated_Finance_NBFC_530127_1282026191518.xml",
    );
  });

  it("does NOT rewrite the legacy NBFC family in the same directory", () => {
    // The half that would be silent if it broke: these URLs serve today, and
    // a directory-wide rewrite would 404 every one of them.
    const legacy =
      "/XBRLFILES/NBFCUploadDocument/NBFC_530127_1392019184956.xml";
    const out = bseInstanceUrlCandidates(legacy);
    assert.deepEqual(out, [`${RESULTS_INSTANCE_HOST.BSE}${legacy}`]);
  });

  it("does not touch the other integrated families, which serve as indexed", () => {
    for (const ok of [
      "/XBRLFILES/IFIndasUploadDocument/Integrated_Finance_Ind_As_500325_1.xml",
      "/XBRLFILES/IFOtherthanUploadDocument/IFOtherthan_531500_1.xml",
      "/XBRLFILES/FourOneUploadDocument/Main_Ind_As_500325_1.xml",
    ]) {
      assert.deepEqual(
        bseInstanceUrlCandidates(ok),
        [`${RESULTS_INSTANCE_HOST.BSE}${ok}`],
        `${ok} serves as indexed and must not be rewritten`,
      );
    }
  });

  it("matches the directory segment case-insensitively", () => {
    // BSE serves from IIS, where the directory segment is case-insensitive.
    // Pinning the casing would let a cosmetic change on their side stop the
    // rewrite firing, which presents as the filings simply vanishing.
    const lower =
      "/XBRLFILES/nbfcuploaddocument/Integrated_Finance_NBFC_530127_1.xml";
    const out = bseInstanceUrlCandidates(lower);
    assert.equal(out.length, 2, "a lowercased directory must still rewrite");
    assert.match(out[1]!, /\/IFNBFCUploadDocument\//);
  });

  it("is idempotent — an already-correct URL yields no second candidate", () => {
    // `IFNBFCUploadDocument` CONTAINS the substring `NBFCUploadDocument`, so a
    // matcher without the leading `/` anchor would produce
    // `/IFIFNBFCUploadDocument/` and 404 on the retry.
    const fixed =
      "/XBRLFILES/IFNBFCUploadDocument/Integrated_Finance_NBFC_530127_1.xml";
    assert.deepEqual(bseInstanceUrlCandidates(fixed), [
      `${RESULTS_INSTANCE_HOST.BSE}${fixed}`,
    ]);
  });

  it("absolutises a site-relative link and passes an absolute one through", () => {
    const abs =
      "https://www.bseindia.com/XBRLFILES/FourOneUploadDocument/Main_Ind_As_1.xml";
    assert.deepEqual(bseInstanceUrlCandidates(abs), [abs]);
    assert.equal(
      bseInstanceUrlCandidates("XBRLFILES/x.xml")[0],
      `${RESULTS_INSTANCE_HOST.BSE}/XBRLFILES/x.xml`,
      "a link with no leading slash must not concatenate into a broken host",
    );
  });
});

describe("filingExchange — the single read path for an entry's exchange", () => {
  it("defaults to NSE, because NSE was the only index that existed", () => {
    assert.equal(filingExchange({}), "NSE");
  });

  it("returns BSE when stated, and never falls back", () => {
    assert.equal(filingExchange({ exchange: "BSE" }), "BSE");
  });
});

describe("buildResultsIndexPath — exchange dispatch", () => {
  it("builds BSE's per-scrip path", () => {
    assert.equal(
      buildResultsIndexPath({ exchange: "BSE", scripCode: "530127" }),
      "/Result_Arch_ng/w?scrip_cd=530127",
    );
  });

  it("leaves the NSE path byte-identical to the legacy builder", () => {
    // Adding BSE must not perturb a single NSE URL. The legacy index needs
    // `period=` and returns [] without it, so a dropped param is a clean 200
    // with no records.
    const nse = buildResultsIndexPath({
      exchange: "NSE",
      era: "legacy",
      from: "01-05-2019",
      to: "31-05-2019",
      size: 500,
      page: 1,
      period: "Quarterly",
    });
    assert.equal(
      nse,
      "/api/corporates-financial-results?period=Quarterly&index=equities" +
        "&from_date=01-05-2019&to_date=31-05-2019&size=500&page=1",
    );
  });

  it("encodes a scrip code rather than interpolating it raw", () => {
    assert.equal(
      buildResultsIndexPath({ exchange: "BSE", scripCode: "5 3&0" }),
      "/Result_Arch_ng/w?scrip_cd=5%203%260",
    );
  });
});

describe("the real BSE instances reach the existing parser", () => {
  it("reads the fixtures (guards against a vacuous suite)", () => {
    for (const name of Object.values(FIXTURE_NAMES)) {
      assert.ok(
        read(name).length > 10_000,
        `${name} missing or truncated — every assertion below would pass ` +
          "against an empty string",
      );
    }
  });

  it("parses all three as FINANCIALS, across both taxonomy families", () => {
    const seen = new Set<string>();
    for (const name of Object.values(FIXTURE_NAMES)) {
      const out = parseXbrlDocument(read(name));
      assert.equal(
        out.kind,
        "financials",
        `${name} did not parse as financials (kind=${out.kind}) — BSE would ` +
          "need a parser family after all",
      );
      seen.add(out.financials.taxonomy.dialect);
    }
    assert.deepEqual(
      [...seen].sort(),
      ["in-bse-fin", "in-capmkt"],
      "the fixtures must span BOTH families, or this proves only one",
    );
  });

  it("dispatches on the namespace the document DECLARES, and BSE hosts one of them", () => {
    const legacy = parseXbrlDocument(read(FIXTURE_NAMES.legacyBseFin));
    assert.equal(legacy.kind, "financials");
    assert.equal(legacy.financials.taxonomy.dialect, "in-bse-fin");
    assert.match(
      legacy.financials.taxonomy.namespace,
      /^http:\/\/www\.bseindia\.com\/xbrl\/fin\//,
      "the legacy family is served from a bseindia.com namespace — this is " +
        "why BSE needed no new parser dispatch",
    );
  });

  it("IDENTITY A — a dual-listed filer states a real symbol", () => {
    const out = parseXbrlDocument(read(FIXTURE_NAMES.dualListed));
    assert.equal(out.kind, "financials");
    assert.equal(out.financials.symbol, "RELIANCE");
    assert.equal(out.financials.scripCode, "500325");
  });

  it("IDENTITY B — a BSE-only filer states the NOTLISTED SENTINEL, not nothing", () => {
    // The whole reason the bridge exists. If this ever starts returning null
    // the sentinel handling can be simplified; while it returns "NOTLISTED",
    // a writer that checks only for emptiness merges companies.
    const out = parseXbrlDocument(read(FIXTURE_NAMES.nbfcSentinel));
    assert.equal(out.kind, "financials");
    assert.equal(
      out.financials.symbol,
      "NOTLISTED",
      "a BSE-only issuer files the sentinel; it is PRESENT and unusable",
    );
    assert.equal(
      out.financials.scripCode,
      "512437",
      "the scrip code is the only real identity such a filing has",
    );
    assert.equal(out.financials.isin, "INE412D01013");
  });

  it("carries a usable period and basis on every fixture", () => {
    // Without these the write path refuses the filing for reasons that have
    // nothing to do with BSE, and "BSE works" would be an empty claim.
    for (const name of Object.values(FIXTURE_NAMES)) {
      const out = parseXbrlDocument(read(name));
      assert.equal(out.kind, "financials");
      assert.match(out.financials.period.start, /^\d{4}-\d{2}-\d{2}$/, name);
      assert.match(out.financials.period.end, /^\d{4}-\d{2}-\d{2}$/, name);
      assert.ok(out.financials.period.days > 0, name);
      assert.ok(
        out.financials.basis === "consolidated" ||
          out.financials.basis === "standalone",
        `${name} states no basis — the unique key would take the index's word`,
      );
    }
  });
});
