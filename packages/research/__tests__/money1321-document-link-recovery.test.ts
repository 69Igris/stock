/**
 * UNIT TEST — recovering the real document from a stored landing page
 * (MONEY-1321).
 *
 * The load-bearing cases, in order of what they protect:
 *
 *   1. **SEBI writes its iframe with SINGLE quotes.** All 605 SEBI pages in the
 *      cohort carry the prospectus in `<iframe src='…'>`. An extractor written
 *      for `src="…"` finds nothing on every one of them and reports the whole
 *      class unrecoverable — which is exactly the reading that made this
 *      ticket look like an egress problem.
 *   2. **The `file=` parameter has TWO spellings, near-evenly split** (335
 *      relative / 269 absolute across those 605). Handling one silently loses
 *      45% of the population while looking like it works.
 *   3. **"Carries a .pdf link" is NOT "recoverable".** On a CRISIL page the
 *      `.pdf` links are methodology boilerplate and the document is the page
 *      itself (median 17,177 chars of rationale). A generic first-link rule
 *      would swap 442 company rating rationales for a generic criteria PDF —
 *      the wrong document, stored confidently. These tests assert the NEGATIVE:
 *      no `document-url` is ever produced for those hosts.
 *   4. **ICRA's rationale is selected by ROLE, not by position.** Every ICRA
 *      page carries four boilerplate attachments (`Annexure I_SEBI.pdf`, …)
 *      alongside the real report. "First .pdf" returns boilerplate.
 *   5. **An unmeasured host is refused, not guessed.** A guessed rule stores
 *      the wrong document, which no downstream check can detect.
 *
 * Fixtures are verbatim fragments captured from the named prod objects on
 * 2026-09-02, not invented markup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recoverDocumentUrl } from "../src/data-sources/document-link-recovery";

// Verbatim from stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt (relative spelling).
const SEBI_RELATIVE = `<div class="portlet-body"><iframe src='../../../web/?file=/sebi_data/attachdocs/sep-2020/1601276746904.pdf' width='100%' style='max-height:90%; height:600px;' title="AAA Technologies Limited - Prospectus" allowfullscreen webkitallowfullscreen>AAA Technologies Limited - Prospectus</iframe></div>`;

// Verbatim from stocks/SEDEMAC/drhp/SEDEMAC-drhp-IPO.txt (absolute spelling).
const SEBI_ABSOLUTE = `<iframe src='../../../web/?file=https://www.sebi.gov.in/sebi_data/attachdocs/mar-2026/1773115712615.pdf' width='100%' title="SEDEMAC MECHATRONICS LIMITED"></iframe>`;

// Shape of the CRISIL rationale pages: boilerplate criteria PDFs only.
const CRISIL = `<html><head><title>Rating Rationale</title></head><body>
  <p>CRISIL Ratings has assigned its rating to the bank facilities of ...</p>
  <a href="http:\\\\www.crisil.com\\Ratings\\SectorMethodology\\MethodologyDocs\\criteria\\Basics of Ratings (including default recognition, assessing information adequacy)_1935.pdf">Basics of Ratings</a>
  <a href="http:\\\\www.crisil.com\\Ratings\\SectorMethodology\\MethodologyDocs\\criteria\\Criteria for manufacturing, trading and corporate services sector.pdf">Criteria</a>
</body></html>`;

// Verbatim ref set from the ICRA pages (Id 139291).
const ICRA = `<html><head><title>ICRA An Affiliate of Moody's</title></head><body>
  <a href="/Content/assets/pdf/Annexure I_SEBI.pdf">Annexure I</a>
  <a href="/Content/assets/pdf/Annexure II_FSR.pdf">Annexure II</a>
  <iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/139291"></iframe>
  <a href="/Content/assets/pdf/ICRA Limited - POSH ICC Details.pdf">POSH</a>
</body></html>`;

describe("recoverDocumentUrl — SEBI", () => {
  it("recovers the prospectus from a SINGLE-QUOTED iframe (all 605 are like this)", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.sebi.gov.in/filings/public-issues/sep-2020/aaa-technologies-limited-prospectus_47614.html",
      html: SEBI_RELATIVE,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/sep-2020/1601276746904.pdf",
    );
  });

  it("recovers the absolute `file=` spelling too (269 of 605)", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.sebi.gov.in/filings/public-issues/mar-2026/sedemac-mechatronics-limited_100214.html",
      html: SEBI_ABSOLUTE,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/mar-2026/1773115712615.pdf",
    );
  });

  it("resolves a root-relative attachment path against the page, not against a guess", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.sebi.gov.in/filings/public-issues/nov-2004/s-a-l-steel-limited_13382.html",
      html: `<iframe src='../../../web/?file=/sebi_data/attachdocs/1293192731280.pdf'></iframe>`,
    });
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/1293192731280.pdf",
    );
  });

  it("falls back to a direct /sebi_data/ anchor when there is no viewer", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.sebi.gov.in/filings/public-issues/jul-2026/x_1.html",
      html: `<a href="https://www.sebi.gov.in/sebi_data/commondocs/jul-2026/Laser%20Power%20and%20Infra%20Limited%20-%20ABr_p.pdf">Abridged</a>`,
    });
    assert.equal(r.kind, "document-url");
    assert.match(
      r.kind === "document-url" ? r.url : "",
      /commondocs\/jul-2026/,
    );
  });

  it("reports the one SEBI page with no attachment as unrecoverable, not as a wrong URL", () => {
    // stocks/RMDRIP/drhp/RMDRIP-drhp-IPO.txt is the single such page measured.
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.sebi.gov.in/filings/public-issues/x/rmdrip_1.html",
      html: `<html><head><title>SEBI | RM Drip</title></head><body><h1>RM Drip</h1></body></html>`,
    });
    assert.equal(r.kind, "unrecoverable");
  });

  it("does not follow a non-PDF iframe (an ad or a nav frame)", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.sebi.gov.in/filings/public-issues/x/y_1.html",
      html: `<iframe src='../../../web/?file=/sebi_data/attachdocs/notes.txt'></iframe>`,
    });
    assert.equal(r.kind, "unrecoverable");
  });
});

describe("recoverDocumentUrl — hosts whose HTML IS the document", () => {
  it("CRISIL: returns html-is-the-document and NEVER a boilerplate criteria PDF", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.crisil.com/mnt/winshare/Ratings/RatingList/RatingDocs/SheetalCoolProductsLimited_March 31_ 2026_RR_392457.html",
      html: CRISIL,
    });
    assert.equal(r.kind, "html-is-the-document");
    // The negative that matters: no URL is produced at all, so the criteria
    // PDF can never be stored in place of the rationale.
    assert.equal("url" in r, false);
  });

  it("Brickwork (bcrisp.in) is treated the same way", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://bcrisp.in///BLRHTML/HTMLDocument/ViewRatingRationaleINCWD?id=204004",
      html: `<title>Rating Rationale</title><a href="https://www.brickworkratings.com/download/Criteria-GeneralCriteriaUpdated.pdf">c</a>`,
    });
    assert.equal(r.kind, "html-is-the-document");
  });

  it("Acuite is treated the same way", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://connect.acuite.in/fcompany-details/MILTON_INDUSTRIES_LIMITED/24th_Feb_26",
      html: `<title>Press Release</title><p>Acuite has assigned...</p>`,
    });
    assert.equal(r.kind, "html-is-the-document");
  });
});

describe("recoverDocumentUrl — ICRA selects by role, not by position", () => {
  it("picks the viewer target, not the first .pdf on the page", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.icra.in/Rationale/ShowRationaleReport/?Id=139291",
      html: ICRA,
    });
    assert.equal(r.kind, "document-url");
    const url = r.kind === "document-url" ? r.url : "";
    assert.equal(
      url,
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
    // The boilerplate must never win.
    assert.doesNotMatch(url, /Annexure/i);
    assert.doesNotMatch(url, /POSH/i);
  });

  it("derives the report from the source URL's Id when the page has no viewer link", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.icra.in/Rationale/ShowRationaleReport/?Id=113558#page=2",
      html: `<html><body><a href="/Content/assets/pdf/Annexure I_SEBI.pdf">A</a></body></html>`,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/113558",
    );
  });

  it("refuses rather than guessing when there is neither a viewer nor an Id", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.icra.in/Rationale/ShowRationaleReport/",
      html: `<html><body><a href="/Content/assets/pdf/Annexure I_SEBI.pdf">A</a></body></html>`,
    });
    assert.equal(r.kind, "unrecoverable");
  });
});

describe("recoverDocumentUrl — measured dead ends and refusals", () => {
  it("India Ratings is unrecoverable, with the measured reason attached", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.indiaratings.co.in/pressrelease/80402",
      html: `<html><head><title>India Ratings and Research</title></head><body></body></html>`,
    });
    assert.equal(r.kind, "unrecoverable");
    assert.match(r.why, /client-rendered/i);
  });

  it("BSE is named as a fetch-strategy problem, not a landing page", () => {
    const r = recoverDocumentUrl({
      sourceUrl:
        "https://www.bseindia.com/xml-data/corpfiling/AttachLive/2230b114-c615-4129-b7c9-accef92a84e5.pdf",
      html: `<html><head><title>LIVE Stock/Share Market</title></head><body></body></html>`,
    });
    assert.equal(r.kind, "unrecoverable");
    assert.match(r.why, /homepage|referer/i);
  });

  it("an unmeasured host is refused rather than guessed", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://example.invalid/investors/presentation",
      html: `<a href="/files/deck.pdf">Investor deck</a>`,
    });
    assert.equal(r.kind, "unrecoverable");
    assert.match(r.why, /no measured rule/i);
  });

  it("a malformed sourceUrl is refused without throwing", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "not a url",
      html: SEBI_RELATIVE,
    });
    assert.equal(r.kind, "unrecoverable");
  });

  it("host matching is case-insensitive", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://WWW.CRISIL.COM/mnt/winshare/x.html",
      html: CRISIL,
    });
    assert.equal(r.kind, "html-is-the-document");
  });
});

/* -------------------------------------------------------------------------- */
/* M11 — `file=` is a PARAMETER NAME, not a substring                          */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 M11: `profile=` is not `file=`", () => {
  // ONE page carrying BOTH spellings, so the assertion is about WHICH value is
  // selected rather than about whether anything is. `indexOf("file=")` finds
  // the one inside `profile=` first, three characters in, and every later
  // guard — the `.pdf` shape test, the same-host check, the fetch — passes on
  // the wrong value. The row then stores another document, confidently.
  const SEBI_DECOY =
    `<iframe src='../../../web/?profile=/sebi_data/attachdocs/WRONG.pdf` +
    `&file=/sebi_data/attachdocs/RIGHT.pdf'></iframe>`;
  const SOURCE = "https://www.sebi.gov.in/filings/public-issues/x_38237.html";

  it("selects the real `file=` even when `profile=` precedes it", () => {
    // MUTATION: restore `candidate.indexOf("file=")` and this goes RED with
    // WRONG.pdf, while every other SEBI case in this file stays green.
    const r = recoverDocumentUrl({ sourceUrl: SOURCE, html: SEBI_DECOY });
    assert.equal(r.kind, "document-url");
    const url = r.kind === "document-url" ? r.url : "";
    assert.equal(url, "https://www.sebi.gov.in/sebi_data/attachdocs/RIGHT.pdf");
    assert.doesNotMatch(url, /WRONG/);
  });

  it("a page whose ONLY match is `profile=` yields no viewer parameter", () => {
    // ICRA is where the difference is visible as a verdict: a null parameter
    // means "no viewer link", so the row falls through to the Id-derived URL
    // built from its own identity instead of to `/web/139291`.
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.icra.in/Rationale/ShowRationaleReport/?Id=139291",
      html: `<html><body><iframe src="/web/viewer.html?profile=139291"></iframe></body></html>`,
    });
    assert.equal(r.kind, "document-url");
    const url = r.kind === "document-url" ? r.url : "";
    assert.equal(
      url,
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
    assert.doesNotMatch(url, /\/web\/139291/);
  });

  it("the ordinary spellings are unaffected — `?file=` and `&file=`", () => {
    for (const html of [
      `<iframe src='../../../web/?file=/sebi_data/attachdocs/a.pdf'></iframe>`,
      `<iframe src='../../../web/?v=1&file=/sebi_data/attachdocs/a.pdf'></iframe>`,
    ]) {
      const r = recoverDocumentUrl({ sourceUrl: SOURCE, html });
      assert.equal(r.kind, "document-url");
      assert.equal(
        r.kind === "document-url" ? r.url : "",
        "https://www.sebi.gov.in/sebi_data/attachdocs/a.pdf",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* M12 — the ICRA `Id` correspondence is ENFORCED, not just documented         */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 M12: an ICRA viewer link must correspond to the page's Id", () => {
  // MEASURED on prod 2026-09-02 across all 196 ICRA rows before this was
  // enforced: 10 have no readable bytes, 125 carry no viewer link at all, and
  // the remaining 61 each carry EXACTLY ONE whose `file=` contains their own
  // `Id`. Zero mismatches, zero pages with two viewer links — so the check
  // narrows nothing today and removes the way this goes wrong later.
  const SOURCE = "https://www.icra.in/Rationale/ShowRationaleReport/?Id=139291";

  it("a corroborated viewer link is used", () => {
    const r = recoverDocumentUrl({
      sourceUrl: SOURCE,
      html: `<iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/139291"></iframe>`,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
  });

  it("a viewer link for a DIFFERENT rationale never wins", () => {
    // The docstring already claimed "its id equals the `Id` already in
    // sourceUrl". The code took the first link BY POSITION and never checked —
    // so one extra viewer link, or a reordered template, stores another
    // company's rationale under this symbol.
    //
    // MUTATION: drop the `idPattern` filter and take `viewerTargets[0]` and
    // this goes RED with 999999, while the corroborated case above stays green.
    const r = recoverDocumentUrl({
      sourceUrl: SOURCE,
      // The decoy is FIRST in document order AND first within the `a href`
      // sweep that `attributeValues` runs before `iframe src` — so "first by
      // position" cannot accidentally pick the right one and pass.
      html:
        `<a href="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/999999">other</a>` +
        `<a href="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/139291">this page</a>`,
    });
    assert.equal(r.kind, "document-url");
    const url = r.kind === "document-url" ? r.url : "";
    assert.equal(
      url,
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
      "the link that corresponds to this page's Id, not the first one",
    );
    assert.doesNotMatch(url, /999999/);
  });

  it("when NO link corresponds, the Id-derived URL wins over the link", () => {
    // An uncorroborated link is not evidence. The derived URL is built from
    // the row's own identity and cannot belong to another company.
    const r = recoverDocumentUrl({
      sourceUrl: SOURCE,
      html: `<iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/424242"></iframe>`,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
    assert.match(
      r.kind === "document-url" ? r.why : "",
      /no viewer link on the page corresponds/,
    );
  });

  it("an Id is matched on a WHOLE number, not as a substring", () => {
    // `139291` must not corroborate a link naming `1392910`.
    const r = recoverDocumentUrl({
      sourceUrl: SOURCE,
      html: `<iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/1392910"></iframe>`,
    });
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
  });

  it("with NO Id in sourceUrl a viewer link is still used — nothing regresses", () => {
    const r = recoverDocumentUrl({
      sourceUrl: "https://www.icra.in/Rationale/ShowRationaleReport/",
      html: `<iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/770077"></iframe>`,
    });
    assert.equal(r.kind, "document-url");
    assert.equal(
      r.kind === "document-url" ? r.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/770077",
    );
  });
});
