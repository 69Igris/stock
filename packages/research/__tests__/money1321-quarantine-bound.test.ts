/**
 * UNIT TEST — the quarantine must never destroy a document we already hold
 * (MONEY-1321).
 *
 * ## The measurement that made this file necessary
 *
 * MONEY-1315 described all 1,573 HTML-bodied rows as ready to quarantine, and
 * `gcsPath: ""` is not reversible in practice — the enrichment pipeline never
 * revisits a cleared row. Opening the pages corrected it. Prod, 2026-09-02,
 * across the full cohort:
 *
 *     www.crisil.com      442 rows   median 17,177 chars   THE PAGE IS THE DOC
 *     bcrisp.in            69 rows   median 13,201 chars   THE PAGE IS THE DOC
 *     connect.acuite.in     9 rows   median 18,288 chars   THE PAGE IS THE DOC
 *     www.sebi.gov.in     605 rows   median    455 chars   landing page
 *     www.indiaratings…   135 rows   median     86 chars   JS shell
 *
 * 520 rows are credit-rating RATIONALES published as the page. CRISIL's own
 * `sourceUrl` ends in `.html`; there was never a PDF to have fetched instead.
 *
 * ## What each case here protects
 *
 *   1. **The 520 are not selected.** MUTATION: delete the
 *      `isHtmlTheDocumentHost` arm from `classifyDocumentRow` (i.e. widen the
 *      selection back to every HTML body) and every case in the first block
 *      goes RED.
 *   2. **The 1,053 that ARE landing pages still are selected.** A guard that
 *      excluded everything would look identical on the first block alone.
 *   3. **ONE host list, TWO readers.** The quarantine's exclusion and the
 *      recovery's routing read the same set, so they cannot drift into the
 *      state where one deletes what the other is trying to save.
 *   4. **SEBI's `file=` has TWO spellings**, 335 relative against 269 absolute
 *      across those 605 pages. Handling one loses 45% while looking like it
 *      works. MUTATION: break the absolute arm and the absolute case goes RED
 *      while the relative one stays green.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyDocumentRow,
  recoveryStillNeedsTheseBytes,
  recoveryLaneNeedsTheBody,
  type DocumentRowClass,
} from "../src/data-sources/document-body-guard";
import {
  recoverDocumentUrl,
  isHtmlTheDocumentHost,
} from "../src/data-sources/document-link-recovery";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf-8");

const KEY = "stocks/ACME/credit_rating/ACME-credit_rating-2026.txt";

function classify(sourceUrl: string | null): DocumentRowClass {
  return classifyDocumentRow({
    gcsPath: KEY,
    sourceUrl,
    objectExists: true,
    bodyIsHtml: true,
  });
}

/* -------------------------------------------------------------------------- */
/* 1. The 520 are EXCLUDED                                                     */
/* -------------------------------------------------------------------------- */

/** Verbatim `sourceUrl` shapes from the prod rows, one per rating-agency host. */
const RATING_AGENCY_URLS: ReadonlyArray<[string, string]> = [
  [
    "CRISIL",
    "https://www.crisil.com/mnt/winshare/Ratings/RatingList/RatingDocs/AcmeIndustriesLimited_June%2018,%202026_RR_356789.html",
  ],
  [
    "Brickwork",
    "https://bcrisp.in/Rating/Report?id=8f2c1a4e-77aa-4c1a-9b21-0f7d0f1c9d02",
  ],
  ["Acuité", "https://connect.acuite.in/rating-rationale/12345"],
];

describe("MONEY-1321: a rating-agency page is NEVER selected for quarantine", () => {
  for (const [agency, url] of RATING_AGENCY_URLS) {
    it(`${agency} classifies htmlIsTheDocument, not html`, () => {
      // MUTATION: remove the isHtmlTheDocumentHost arm from
      // classifyDocumentRow and this returns "html" — the row's gcsPath is
      // blanked and the rationale is gone.
      assert.equal(classify(url), "htmlIsTheDocument");
    });
  }

  it("the migration only pushes ids inside its `html` branch", () => {
    // The exclusion is STRUCTURAL, not a filter applied afterwards. This reads
    // the migration's source because the property is about WHERE the push is,
    // and no return value can express that.
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    const pushes = [
      ...src.matchAll(/census\.quarantine(Ids|Keys)\.(push|add)\(/g),
    ];
    assert.equal(pushes.length, 2, "exactly one id push and one key push");
    const guard = src.indexOf('if (cls !== "html") {');
    assert.ok(guard > 0, "the `cls !== html` early-continue must exist");
    for (const m of pushes) {
      assert.ok(
        m.index! > guard,
        "every quarantine push must sit AFTER the non-html continue",
      );
    }
  });

  it("the migration projects sourceUrl, or the classifier cannot see the host", () => {
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    assert.match(src, /sourceUrl: \{ \$ifNull: \["\$sourceUrl", null\] \}/);
    // Both call sites must pass it — an omitted argument would be a compile
    // error, but a `null` passed for convenience would not be. Scoped to each
    // CALL rather than counted file-wide: a file-wide count silently breaks the
    // moment any other function is handed `row.sourceUrl` (MONEY-1321 H2's
    // guard does exactly that), which would make this assertion a maintenance
    // trap rather than a check.
    const calls = [...src.matchAll(/classifyDocumentRow\(\{/g)];
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.match(
        src.slice(c.index!, c.index! + 220),
        /sourceUrl: row\.sourceUrl,/,
        "each classifyDocumentRow call must pass the ROW's sourceUrl",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The landing pages ARE still selected — the guard is not a blanket        */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: CONTROL — a real landing page is still quarantined", () => {
  const STILL_QUARANTINED: ReadonlyArray<[string, string]> = [
    [
      "SEBI",
      "https://www.sebi.gov.in/filings/public-issues/mar-2018/acme-limited_38237.html",
    ],
    ["ICRA", "https://www.icra.in/Rating/ShowRationalReport?Id=139291"],
    ["India Ratings", "https://www.indiaratings.co.in/pressrelease/12345"],
    [
      "BSE",
      "https://www.bseindia.com/bseplus/AnnualReport/543766/74205590122.pdf",
    ],
    ["a company IR page", "https://www.irb.co.in/investors/annual-report.html"],
  ];

  for (const [who, url] of STILL_QUARANTINED) {
    it(`${who} still classifies html`, () => {
      assert.equal(classify(url), "html");
    });
  }

  it("a null or unparseable sourceUrl is NOT treated as a rating page", () => {
    // The safe answer for "we cannot tell" is to quarantine, not to keep: a
    // wrong TRUE leaves a genuinely-empty row claiming a document forever,
    // which is the failure MONEY-1315 exists to fix.
    assert.equal(classify(null), "html");
    assert.equal(classify(""), "html");
    assert.equal(classify("not a url at all"), "html");
  });

  it("the earlier classes still short-circuit ahead of the new arm", () => {
    const crisil = RATING_AGENCY_URLS[0]![1];
    assert.equal(
      classifyDocumentRow({
        gcsPath: "",
        sourceUrl: crisil,
        objectExists: true,
        bodyIsHtml: true,
      }),
      "alreadyQuarantined",
    );
    assert.equal(
      classifyDocumentRow({
        gcsPath: KEY,
        sourceUrl: crisil,
        objectExists: false,
        bodyIsHtml: true,
      }),
      "objectMissing",
    );
    assert.equal(
      classifyDocumentRow({
        gcsPath: KEY,
        sourceUrl: crisil,
        objectExists: true,
        bodyIsHtml: false,
      }),
      "ok",
      "a rating host holding a REAL document is `ok`, not the new class",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. ONE host list, TWO readers                                               */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: the quarantine and the recovery read the SAME host list", () => {
  const ALL_HOSTS: readonly string[] = [
    "https://www.crisil.com/x.html",
    "https://crisil.com/x.html",
    "https://bcrisp.in/Rating/Report?id=1",
    "https://www.bcrisp.in/Rating/Report?id=1",
    "https://connect.acuite.in/rating-rationale/1",
    "https://www.sebi.gov.in/x.html",
    "https://www.icra.in/Rating/ShowRationalReport?Id=1",
    "https://www.indiaratings.co.in/x",
    "https://www.bseindia.com/x.pdf",
    "https://www.irb.co.in/x.html",
  ];

  for (const url of ALL_HOSTS) {
    it(`${new URL(url).host}: both readers agree`, () => {
      const excluded = isHtmlTheDocumentHost(url);
      const routed =
        recoverDocumentUrl({ sourceUrl: url, html: "" }).kind ===
        "html-is-the-document";
      assert.equal(
        excluded,
        routed,
        "a host the quarantine keeps must be one the recovery extracts, and " +
          "vice versa — otherwise one deletes what the other is saving",
      );
      assert.equal(
        excluded,
        classify(url) === "htmlIsTheDocument",
        "and the row classifier must agree with both",
      );
    });
  }

  it("isHtmlTheDocumentHost is defensive about the input, not about the answer", () => {
    assert.equal(isHtmlTheDocumentHost(null), false);
    assert.equal(isHtmlTheDocumentHost(undefined), false);
    assert.equal(isHtmlTheDocumentHost("   "), false);
    assert.equal(isHtmlTheDocumentHost("://broken"), false);
    assert.equal(isHtmlTheDocumentHost("HTTPS://WWW.CRISIL.COM/x.html"), true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. SEBI's TWO `file=` spellings                                             */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: both SEBI `file=` spellings recover, 335 + 269", () => {
  // Verbatim from stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt. Single quotes,
  // relative viewer path.
  const RELATIVE = `<div class="portlet-body"><iframe src='../../../web/?file=/sebi_data/attachdocs/sep-2020/1601276746904.pdf' width='100%'>x</iframe></div>`;
  // Verbatim from stocks/SEDEMAC/drhp/SEDEMAC-drhp-IPO.txt.
  const ABSOLUTE = `<iframe src='../../../web/?file=https://www.sebi.gov.in/sebi_data/attachdocs/mar-2026/1773115712615.pdf' width='100%'></iframe>`;
  const SOURCE = "https://www.sebi.gov.in/filings/public-issues/x_38237.html";

  it("the RELATIVE spelling resolves against the page", () => {
    const rec = recoverDocumentUrl({ sourceUrl: SOURCE, html: RELATIVE });
    assert.equal(rec.kind, "document-url");
    assert.equal(
      rec.kind === "document-url" ? rec.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/sep-2020/1601276746904.pdf",
    );
  });

  it("the ABSOLUTE spelling is carried through unchanged", () => {
    // MUTATION: make `absolutise` prepend the base path, or make
    // `viewerFileParam` return only values starting with "/", and this goes RED
    // while the relative case above stays green — 269 of 605 pages lost, with
    // nothing to reveal it.
    const rec = recoverDocumentUrl({ sourceUrl: SOURCE, html: ABSOLUTE });
    assert.equal(rec.kind, "document-url");
    assert.equal(
      rec.kind === "document-url" ? rec.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/mar-2026/1773115712615.pdf",
    );
  });

  it("BOTH resolve onto SEBI's own host, which the backfill requires", () => {
    for (const html of [RELATIVE, ABSOLUTE]) {
      const rec = recoverDocumentUrl({ sourceUrl: SOURCE, html });
      assert.equal(rec.kind, "document-url");
      if (rec.kind !== "document-url") return;
      assert.equal(
        new URL(rec.url).host,
        new URL(SOURCE).host,
        "the backfill refuses a cross-host recovery, so a same-host result is " +
          "not incidental — it is the property that makes the fetch reachable",
      );
    }
  });

  it("a CRISIL page never produces a document-url, whatever links it carries", () => {
    // The methodology-boilerplate trap: a first-link parser would swap 442
    // company rating rationales for a generic criteria PDF.
    const crisil = `<html><body><p>CRISIL Ratings has assigned…</p>
      <a href="https://www.crisil.com/criteria/Basics%20of%20Ratings_1935.pdf">Basics of Ratings</a>
      <a href="https://www.crisil.com/criteria/Criteria%20for%20manufacturing.pdf">Criteria</a>
      </body></html>`;
    const rec = recoverDocumentUrl({
      sourceUrl: RATING_AGENCY_URLS[0]![1],
      html: crisil,
    });
    assert.equal(rec.kind, "html-is-the-document");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. H2 — the destructive job may not run before the constructive one         */
/* -------------------------------------------------------------------------- */

/** Verbatim shape of a SEBI landing page: chrome around one viewer iframe. */
const SEBI_PAGE =
  `<!DOCTYPE html><html><head><title>SEBI | Acme Limited - Prospectus</title></head>` +
  `<body><div class="portlet-body"><iframe src='../../../web/?file=/sebi_data/attachdocs/` +
  `sep-2020/1601276746904.pdf' width='100%'>x</iframe></div></body></html>`;
const SEBI_SOURCE =
  "https://www.sebi.gov.in/filings/public-issues/mar-2018/acme_38237.html";

describe("MONEY-1321 H2: the order guard, not the order comment", () => {
  it("a SEBI row still holding its viewer page is STILL NEEDED", () => {
    // These bytes are the only copy of the link to the prospectus. Blanking
    // gcsPath now makes the row unrecoverable, and nothing revisits a cleared
    // row.
    //
    // MUTATION: make `recoveryStillNeedsTheseBytes` return false and this goes
    // RED — which is exactly the state the two headers described as safe.
    assert.equal(
      recoveryStillNeedsTheseBytes({
        sourceUrl: SEBI_SOURCE,
        html: SEBI_PAGE,
      }),
      true,
    );
  });

  it("a SEBI page with no viewer link is NOT needed — the guard converges", () => {
    // The guard has no override flag, so it MUST clear itself once the
    // recovery has done what it can. A page the router cannot recover from is
    // free to quarantine.
    assert.equal(
      recoveryStillNeedsTheseBytes({
        sourceUrl: SEBI_SOURCE,
        html: `<!DOCTYPE html><html><body><p>Not found</p></body></html>`,
      }),
      false,
    );
  });

  it("an UNREADABLE page is treated as needed by the caller, not by a guess", () => {
    // The pure function is handed `""` when the read failed; it answers false,
    // and the SCRIPT turns "we could not check" into "still needed". Asserting
    // both halves so neither can be dropped as redundant.
    assert.equal(
      recoveryStillNeedsTheseBytes({ sourceUrl: SEBI_SOURCE, html: "" }),
      false,
    );
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    assert.match(
      src,
      /page === null \|\|\s*recoveryStillNeedsTheseBytes\(/,
      "a failed read must fall on the REFUSE side of the one-way door",
    );
  });

  it("a CROSS-HOST link is not something these bytes can buy", () => {
    // The recovery refuses a cross-host recovery, so holding the page back
    // would block the quarantine forever over a row nothing will ever fix.
    assert.equal(
      recoveryStillNeedsTheseBytes({
        sourceUrl: SEBI_SOURCE,
        html: `<iframe src='../../../web/?file=https://evil.example.com/sebi_data/x.pdf'></iframe>`,
      }),
      false,
    );
  });

  it("an ICRA row is needed too — but recovers from the URL alone as well", () => {
    assert.equal(
      recoveryStillNeedsTheseBytes({
        sourceUrl:
          "https://www.icra.in/Rationale/ShowRationaleReport/?Id=139291",
        html: "",
      }),
      true,
      "ICRA derives its PDF from the Id, so even an unread page is 'needed'",
    );
  });

  it("a rating-agency page and an unmeasured host are NOT one-hop rows", () => {
    // The read gate is the router's own lane, so no host list is restated in
    // the migration.
    assert.equal(recoveryLaneNeedsTheBody(SEBI_SOURCE), true);
    assert.equal(
      recoveryLaneNeedsTheBody("https://www.icra.in/Rationale/?Id=1"),
      true,
    );
    assert.equal(recoveryLaneNeedsTheBody(RATING_AGENCY_URLS[0]![1]), false);
    assert.equal(
      recoveryLaneNeedsTheBody("https://www.indiaratings.co.in/x"),
      false,
    );
    assert.equal(
      recoveryLaneNeedsTheBody("https://www.irb.co.in/x.html"),
      false,
    );
    assert.equal(recoveryLaneNeedsTheBody(null), false);
  });

  it("nothing is claimed for a row with no sourceUrl", () => {
    assert.equal(
      recoveryStillNeedsTheseBytes({ sourceUrl: null, html: SEBI_PAGE }),
      false,
    );
    assert.equal(
      recoveryStillNeedsTheseBytes({ sourceUrl: "not a url", html: SEBI_PAGE }),
      false,
    );
  });

  it("the migration REFUSES --apply, and refuses BEFORE it writes anything", () => {
    // A comment is not a guard. The refusal has to be unreachable-by-order, and
    // it has to be positioned ahead of the confirmation and the update.
    //
    // MUTATION: delete the `opts.apply && census.recoverable.length > 0` throw
    // and this goes RED.
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    const refuse = src.indexOf(
      "if (opts.apply && census.recoverable.length > 0)",
    );
    assert.ok(refuse > 0, "the H2 refusal must exist");
    assert.match(src, /REFUSING to quarantine/);
    const confirmAt = src.indexOf("const ok = await confirm(");
    const writeAt = src.indexOf("update: COLLECTION,");
    assert.ok(confirmAt > refuse, "refuse before the operator is even asked");
    assert.ok(
      writeAt > refuse,
      "refuse before any $set reaches the collection",
    );
    // And there must be no escape hatch: an override flag would put the
    // dangerous order back one keystroke away.
    assert.doesNotMatch(src, /--force-recover|--skip-recovery|--i-know/);
  });

  it("the guard's population is counted and PRINTED, even at zero", () => {
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    assert.match(src, /RECOVERABLE-FIRST GUARD/);
    // Printed outside the `> 0` branch: a line that only appears on failure
    // cannot tell an operator that the check ran.
    const header = src.indexOf("RECOVERABLE-FIRST GUARD");
    const gate = src.indexOf("if (census.recoverable.length > 0) {", header);
    assert.ok(gate > header, "the heading precedes the non-empty branch");
  });

  it("both migration headers now state the required ORDER", () => {
    const quarantine = read(
      "scripts/migrations/quarantine-html-stock-documents.ts",
    );
    const recovery = read("scripts/migrations/recover-html-stock-documents.ts");
    // The FALSE claim must be gone from both — it is the claim that made the
    // dangerous order look safe.
    for (const [name, src] of [
      ["quarantine", quarantine],
      ["recovery", recovery],
    ] as const) {
      assert.doesNotMatch(
        src,
        /Order against the quarantine does not matter|Running order does not\s*\n \* matter/,
        `${name} must not still claim order is irrelevant`,
      );
      assert.match(
        src,
        /RUN THE RECOVERY FIRST|RUN THIS ONE FIRST/,
        `${name} must state the order`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. M5 — a shared object may not be deleted while a KEPT row points at it    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 M5: the per-key verdict is no longer uniform", () => {
  it("two rows over the SAME bytes can split on sourceUrl alone", () => {
    // This is the property the deletion comment assumed away. `gcsPath` is
    // derived from symbol/docType/period and carries no exchange, so siblings
    // share a key — and MONEY-1321 made the CLASS depend on the row's own
    // `sourceUrl`.
    const key = "stocks/ACME/credit_rating/ACME-credit_rating-2026.txt";
    const shared = (sourceUrl: string): DocumentRowClass =>
      classifyDocumentRow({
        gcsPath: key,
        sourceUrl,
        objectExists: true,
        bodyIsHtml: true,
      });
    assert.equal(shared("https://www.crisil.com/x.html"), "htmlIsTheDocument");
    assert.equal(shared("https://www.sebi.gov.in/x.html"), "html");
    assert.notEqual(
      shared("https://www.crisil.com/x.html"),
      shared("https://www.sebi.gov.in/x.html"),
      "identical bytes, identical key, different verdicts — the hazard",
    );
  });

  it("the migration WITHHOLDS a key any kept row still points at", () => {
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    // Kept rows record their key…
    assert.match(src, /census\.keptKeys\.add\(row\.gcsPath!\)/);
    // …and the delete set is the quarantined keys MINUS those.
    assert.match(
      src,
      /const deletableKeys = \[\.\.\.census\.quarantineKeys\]\.filter\(\s*\(k\) => !census\.keptKeys\.has\(k\),\s*\);/,
    );
    const deleteLoop = src.indexOf("await bucket.file(key).delete()");
    const keysDecl = src.indexOf("const keys = deletableKeys;");
    assert.ok(
      keysDecl > 0 && keysDecl < deleteLoop,
      "the loop uses the filtered set",
    );
    // The false claim is gone.
    assert.doesNotMatch(
      src,
      /every row sharing a key gets the identical class/,
      "MONEY-1321 broke that; the comment must not still assert it",
    );
  });

  it("the kept-row record sits in the NON-html branch, structurally", () => {
    // If it were recorded for every row, every key would be withheld and
    // --delete-objects would silently become a no-op.
    const src = read("scripts/migrations/quarantine-html-stock-documents.ts");
    const guard = src.indexOf('if (cls !== "html") {');
    const add = src.indexOf("census.keptKeys.add(row.gcsPath!)");
    const push = src.indexOf("census.quarantineIds.push(row.id)");
    assert.ok(guard > 0 && add > guard && add < push);
  });
});
