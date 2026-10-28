/**
 * UNIT TEST — the HTML recovery backfill (MONEY-1321).
 *
 * `scripts/migrations/recover-html-stock-documents.ts` is what the 1,310 salvageable
 * rows are FOR. Its whole decision is
 * `recover-html-stock-documents-logic.mts` — a separate module for the reason
 * `xbrl-projection-drain-logic.mts` is one: the script's module scope calls
 * `run()`, so importing IT from a test would start a corpus walk against
 * whatever `DATABASE_URL` happened to be ambient.
 *
 * What each block protects:
 *
 *   1. **The two lanes never cross.** A CRISIL row must NEVER produce a fetch:
 *      its `.pdf` links are methodology boilerplate, so fetching one swaps a
 *      company rating rationale for a generic criteria PDF — the wrong
 *      document, stored confidently, with nothing in the row to reveal it.
 *   2. **Idempotence.** A completed row is settled BEFORE its bytes are read,
 *      and a row a previous run already fixed reads `notHtml` from the bytes
 *      rather than being written twice.
 *   3. **A moment is not a fact.** `noBytes` and `textTooShort` leave the row
 *      exactly as it was — this job only ever fills a row in.
 *   4. **Dry-run by default, and the dry run reaches no upstream.** The fetch
 *      exists in exactly one function, and `--apply` is TTY-gated.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  planRecovery,
  recoveryLaneFor,
  recoveryHostOf,
  bodyIsAWebPage,
  isMissingObjectError,
  MIN_RECOVERED_TEXT,
  RECOVERY_OUTCOMES,
  RECOVERY_RUN_FAULTS,
  type RecoveryOutcome,
} from "../../../scripts/migrations/recover-html-stock-documents-logic.mjs";
import { sniffDocumentContainer } from "@usemoney/core/market-data/doc-container";
import { sniffDocumentBody } from "@usemoney/research/data-sources/document-body-guard";

/**
 * `repoRoot()`, not a hand-rolled three-`..` anchor off `import.meta.url`.
 *
 * `read()` below is pointed at the migration script and at a worker source
 * file, and the assertions are SCANS over what comes back. A hand-rolled anchor
 * always produces *a* directory, so the day this file moves a level the root is
 * silently wrong, the scans run against a tree that is not ours, and a scan
 * that finds nothing reports every assertion green. The helper anchors the same
 * way and then ASSERTS `yarn.lock`, so that day fails naming the reason
 * (MONEY-1327).
 */
const REPO = repoRoot();
const read = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf-8");

const SEBI_URL =
  "https://www.sebi.gov.in/filings/public-issues/mar-2018/acme_38237.html";
const SEBI_PAGE = Buffer.from(
  `<!DOCTYPE html><html><head><title>SEBI | Acme Limited - Prospectus</title></head><body>` +
    `<iframe src='../../../web/?file=/sebi_data/attachdocs/sep-2020/1601276746904.pdf'>x</iframe>` +
    `</body></html>`,
  "utf-8",
);

const ICRA_URL = "https://www.icra.in/Rating/ShowRationalReport?Id=139291";
const ICRA_PAGE = Buffer.from(
  `<html><head><title>ICRA</title></head><body>` +
    `<a href="/Rating/DownloadFile?Id=1">Annexure I_SEBI.pdf</a>` +
    `<iframe src="/web/viewer.html?file=/Rating/ShowRationalReportFilePdf/139291"></iframe>` +
    `</body></html>`,
  "utf-8",
);

const CRISIL_URL =
  "https://www.crisil.com/mnt/winshare/Ratings/RatingDocs/Acme_June%2018,%202026_RR_356789.html";
const CRISIL_PAGE = Buffer.from(
  `<html><head><title>Rating Rationale</title></head><body>` +
    `<p>CRISIL Ratings has assigned its CRISIL BBB-/Stable rating to the bank facilities of Acme Industries Limited. ` +
    `The rating reflects the company's established market position and healthy operating efficiency, ` +
    `partially offset by a working-capital-intensive operation and modest scale.</p>` +
    `<a href="https://www.crisil.com/criteria/Basics%20of%20Ratings_1935.pdf">Basics of Ratings</a>` +
    `</body></html>`,
  "utf-8",
);

const A_REAL_PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n1 0 obj\n"),
  Buffer.alloc(3000, "x"),
  Buffer.from("\n%%EOF\n"),
]);

const FRESH = {
  processingStatus: "UNSUPPORTED" as string | null,
  hasText: false,
  // MONEY-1321 M13 — REQUIRED, never optional. A default here would mean a
  // caller that forgets it reports every GCS auth failure as `noBytes`.
  readFailed: false,
};

/* -------------------------------------------------------------------------- */
/* 1. The two lanes                                                            */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: the ONE-HOP lane", () => {
  it("SEBI plans a fetch of the viewer's own file= target", () => {
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/ACME-drhp-IPO.txt",
      ...FRESH,
      body: SEBI_PAGE,
    });
    assert.equal(plan.outcome, "oneHopPlanned");
    assert.equal(plan.write?.kind, "one-hop");
    assert.equal(
      plan.write?.kind === "one-hop" ? plan.write.url : "",
      "https://www.sebi.gov.in/sebi_data/attachdocs/sep-2020/1601276746904.pdf",
    );
  });

  it("ICRA selects the rationale by ROLE, not the SEBI annexure boilerplate", () => {
    const plan = planRecovery({
      sourceUrl: ICRA_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      ...FRESH,
      body: ICRA_PAGE,
    });
    assert.equal(plan.outcome, "oneHopPlanned");
    const url = plan.write?.kind === "one-hop" ? plan.write.url : "";
    assert.equal(
      url,
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
    assert.doesNotMatch(url, /Annexure/i, "every ICRA page carries that one");
  });

  it("a CROSS-HOST recovery is refused and COUNTED", () => {
    // `recoverDocumentUrl` absolutises the viewer's `file=` against the page,
    // so an absolute value could name any host. A refusal must be visible, not
    // a silent skip.
    const hostile = Buffer.from(
      `<html><body><iframe src='../../../web/?file=https://evil.example.com/sebi_data/x.pdf'></iframe></body></html>`,
      "utf-8",
    );
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/x.txt",
      ...FRESH,
      body: hostile,
    });
    assert.equal(plan.outcome, "crossHostRefused");
    assert.equal(plan.write, null, "nothing may be fetched");
  });
});

describe("MONEY-1321: the TEXT-IS-THE-DOCUMENT lane", () => {
  it("CRISIL extracts in place and plans NO fetch", () => {
    const plan = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      ...FRESH,
      body: CRISIL_PAGE,
    });
    assert.equal(plan.outcome, "textPlanned");
    assert.equal(plan.write?.kind, "text");
    if (plan.write?.kind !== "text") return;
    assert.match(plan.write.text, /CRISIL Ratings has assigned/);
    assert.doesNotMatch(
      plan.write.text,
      /<a href|<p>/,
      "the markup must be stripped, not carried into textContent",
    );
    // The trap, asserted as a NEGATIVE: the boilerplate PDF must never become
    // a URL to fetch.
    assert.equal(
      JSON.stringify(plan.write).includes("Basics%20of%20Ratings"),
      false,
    );
  });

  it("a page too thin to be a document is LEFT ALONE, not written", () => {
    // `READY` over forty characters of navigation chrome is a lie no reader can
    // detect, so "we could not read it" stays a finding.
    const thin = Buffer.from(
      "<html><head><title>x</title></head><body><p>Loading</p></body></html>",
      "utf-8",
    );
    const plan = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      ...FRESH,
      body: thin,
    });
    assert.equal(plan.outcome, "textTooShort");
    assert.equal(plan.write, null);
  });

  it("a page opening with a bare <title> is still routed — 9 Acuité rows", () => {
    // MEASURED, and this is the case that made the routing predicate a
    // decision rather than a default. Across all 1,580 HTML-bodied prod rows
    // the corruption predicate (`classifyArchivedObject`, via
    // `sniffDocumentBody`) and the routing one (`sniffDocumentContainer`)
    // disagree on exactly TEN, all in one direction. Nine are Acuité pages
    // that open `<title>Press Release</title>` with no `<!doctype>` or
    // `<html>` wrapper. Routing on the corruption predicate silently drops all
    // nine while reporting them as already-fine documents.
    const acuite = Buffer.from(
      `<title>Press Release</title><meta charset="UTF-8">\n` +
        `<link href="/Font/font.css" rel="stylesheet">\n` +
        `<div>Acuité has assigned the long-term rating of ACUITE BBB-/Stable ` +
        `to the bank facilities of Acme Industries Limited, reflecting an ` +
        `established operating track record and moderate financial risk.</div>`,
      "utf-8",
    );
    const plan = planRecovery({
      sourceUrl: "https://connect.acuite.in/rating-rationale/12345",
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      ...FRESH,
      body: acuite,
    });
    assert.equal(plan.outcome, "textPlanned");
    assert.match(
      plan.write?.kind === "text" ? plan.write.text : "",
      /Acuité has assigned/,
    );
  });

  it("a BOM before <!DOCTYPE html> is still routed — the 10th row", () => {
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        `<!DOCTYPE html>\r\n<html>\r\n<head><meta charset="utf-8"></head>` +
          `<body><a href="/investors/report.pdf">Annual Report</a></body></html>`,
        "utf-8",
      ),
    ]);
    // knrcl.com has no measured rule, so the VERDICT is `unrecoverable` — but
    // the row must reach that verdict, not be dismissed as "not a web page".
    // The distinction is the difference between a measured refusal and a blind
    // spot.
    const plan = planRecovery({
      sourceUrl: "https://knrcl.com/investors/annual-report.html",
      gcsPath: "stocks/KNRCON/annual_report/x.txt",
      ...FRESH,
      body: bom,
    });
    assert.equal(plan.outcome, "unrecoverable");
  });

  it("a multipart envelope is peeled here too, not only by the caller", () => {
    // The planner is pure and is called from a test as well as from the
    // script; making it correct standalone beats making it correct by
    // convention. 1,046 of the 1,573 rows are enveloped.
    const inner = Buffer.from(
      `<html><body><p>CRISIL Ratings has assigned its rating to the bank ` +
        `facilities of Acme Industries Limited, reflecting an established ` +
        `market position.</p></body></html>`,
      "utf-8",
    );
    const bare = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "k",
      ...FRESH,
      body: inner,
    });
    assert.equal(bare.outcome, "textPlanned");
  });

  it("MIN_RECOVERED_TEXT is the same 50 the extract worker uses", () => {
    const worker = read("workers/src/processors/stock-document-extract.ts");
    const m = worker.match(/const MIN_TEXT_LENGTH = (\d+);/);
    assert.ok(m, "the worker's floor must still be findable");
    assert.equal(
      MIN_RECOVERED_TEXT,
      Number(m[1]),
      "two floors for one question drift; if the worker's moves, move this",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Idempotence                                                              */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: the backfill is idempotent", () => {
  it("a recovered row settles BEFORE its bytes are needed", () => {
    // The body is deliberately null: if this arm needed bytes, a re-run would
    // spend a GCS read per already-recovered row.
    const plan = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      processingStatus: "READY",
      hasText: true,
      body: null,
      readFailed: false,
    });
    assert.equal(plan.outcome, "alreadyRecovered");
    assert.equal(plan.write, null);
  });

  it("READY with NO text is not `alreadyRecovered` — both halves are required", () => {
    const plan = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      processingStatus: "READY",
      hasText: false,
      body: CRISIL_PAGE,
      readFailed: false,
    });
    assert.equal(plan.outcome, "textPlanned");
  });

  it("a row a PREVIOUS run already fixed reads notHtml from the BYTES", () => {
    // The one-hop lane replaces the object with a real PDF and leaves the row
    // PENDING, so `alreadyRecovered` cannot cover it — the second run has to
    // recognise the bytes.
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/ACME-drhp-IPO.pdf",
      processingStatus: "PENDING",
      hasText: false,
      body: A_REAL_PDF,
      readFailed: false,
    });
    assert.equal(plan.outcome, "notHtml");
    assert.equal(plan.write, null);
  });

  it("the SAME inputs give the SAME plan — no clock, no randomness", () => {
    const args = {
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/x.txt",
      ...FRESH,
      body: SEBI_PAGE,
    };
    assert.deepEqual(planRecovery(args), planRecovery(args));
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Moments are not facts                                                    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: a moment never becomes a verdict", () => {
  it("no bytes is its OWN outcome, distinct from unrecoverable", () => {
    // The quarantine may already have blanked `gcsPath`. That is a moment; the
    // page is still recoverable from `sourceUrl`.
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "",
      ...FRESH,
      body: null,
    });
    assert.equal(plan.outcome, "noBytes");
    assert.equal(plan.write, null);
  });

  it("an unmeasured host is `unrecoverable`, never a guess", () => {
    const plan = planRecovery({
      sourceUrl: "https://www.irb.co.in/investors/annual-report.html",
      gcsPath: "stocks/IRB/annual_report/x.txt",
      ...FRESH,
      body: Buffer.from("<html><body><a href='x.pdf'>report</a></body></html>"),
    });
    assert.equal(plan.outcome, "unrecoverable");
    assert.equal(plan.write, null);
  });

  it("every outcome the planner can return is in the reported vocabulary", () => {
    // A census that cannot NAME an outcome reports it as nothing.
    const seen: RecoveryOutcome[] = [];
    const cases = [
      {
        sourceUrl: SEBI_URL,
        gcsPath: "k",
        processingStatus: "READY",
        hasText: true,
        body: null,
        readFailed: false,
      },
      { sourceUrl: SEBI_URL, gcsPath: "", ...FRESH, body: null },
      { sourceUrl: SEBI_URL, gcsPath: "k", ...FRESH, body: A_REAL_PDF },
      { sourceUrl: SEBI_URL, gcsPath: "k", ...FRESH, body: SEBI_PAGE },
      { sourceUrl: CRISIL_URL, gcsPath: "k", ...FRESH, body: CRISIL_PAGE },
      {
        sourceUrl: CRISIL_URL,
        gcsPath: "k",
        ...FRESH,
        body: Buffer.from("<html><body>x</body></html>"),
      },
      {
        sourceUrl: "https://www.irb.co.in/x.html",
        gcsPath: "k",
        ...FRESH,
        body: Buffer.from("<html><body>hello</body></html>"),
      },
    ];
    for (const c of cases) seen.push(planRecovery(c).outcome);
    for (const o of seen) assert.ok(RECOVERY_OUTCOMES.includes(o), o);
    assert.ok(
      new Set(seen).size >= 6,
      `expected ≥6 distinct outcomes, got ${new Set(seen).size}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Lane routing from the HOST alone                                         */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: the lane is decided by the host, before any read", () => {
  it("routes each measured host without a body", () => {
    assert.equal(recoveryLaneFor(SEBI_URL), "one-hop");
    assert.equal(recoveryLaneFor(ICRA_URL), "one-hop");
    assert.equal(recoveryLaneFor(CRISIL_URL), "text");
    assert.equal(
      recoveryLaneFor("https://bcrisp.in/Rating/Report?id=1"),
      "text",
    );
    assert.equal(recoveryLaneFor("https://connect.acuite.in/x"), "text");
    assert.equal(recoveryLaneFor("https://www.indiaratings.co.in/x"), null);
    assert.equal(recoveryLaneFor("https://www.bseindia.com/x.pdf"), null);
    assert.equal(recoveryLaneFor(null), null);
    assert.equal(recoveryLaneFor(""), null);
  });

  it("recoveryHostOf is the ONE host spelling the decision uses", () => {
    assert.equal(
      recoveryHostOf("HTTPS://WWW.SEBI.GOV.IN/x"),
      "www.sebi.gov.in",
    );
    assert.equal(recoveryHostOf(null), "");
    assert.equal(recoveryHostOf("nonsense"), "");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Dry run by default, and the dry run reaches no upstream                  */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321: the script writes nothing without --apply", () => {
  const src = read("scripts/migrations/recover-html-stock-documents.ts");

  it("`apply` comes from an explicit flag, never a default", () => {
    assert.match(src, /const apply = has\("--apply"\);/);
    assert.doesNotMatch(src, /apply:\s*true/);
  });

  it("--apply is refused without a TTY", () => {
    // A hung prompt exits 0, which a wrapper's `&&` reads as success.
    assert.match(src, /if \(apply && !process\.stdin\.isTTY\)/);
  });

  it("an unknown flag is an ERROR, so --apply cannot be swallowed", () => {
    assert.match(src, /Unknown flag\(s\)/);
    assert.match(src, /Use "--flag value", not/);
  });

  it("a SAMPLED dry run cannot be combined with a corpus-wide write", () => {
    assert.match(src, /--limit cannot be combined with --apply/);
    assert.match(src, /--host cannot be combined with --apply/);
  });

  it("the ONLY fetch lives in applyPlan — a dry run reaches no third party", () => {
    const applyAt = src.indexOf("async function applyPlan(");
    assert.ok(applyAt > 0);
    const fetches = [...src.matchAll(/\bsafeFetch\(/g)];
    assert.equal(fetches.length, 1, "exactly one fetch call site");
    assert.ok(
      fetches[0]!.index! > applyAt,
      "the fetch must sit inside applyPlan, which only --apply reaches",
    );
  });

  it("the fetch is host-pinned even across a redirect", () => {
    assert.match(src, /allowedHosts: \[allowedHost\]/);
  });

  it("it never clears gcsPath and never deletes an object", () => {
    // ADDITIVE ONLY. Every failure leaves the row exactly as it was, which is
    // what lets the selection narrow where the quarantine's could not.
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.doesNotMatch(code, /gcsPath: ""/);
    assert.doesNotMatch(code, /\.delete\(/);
    assert.doesNotMatch(code, /ABSENT_GCS_PATH/);
  });

  it("a recovered document's mimeType comes from the BYTES", () => {
    assert.match(src, /resolveStoredMimeType\(\{ body: buffer \}\)/);
    assert.match(src, /initialProcessingStatus\(mimeType\)/);
  });

  it("the text lane leaves gcsPath and mimeType exactly as they are", () => {
    const textArm = src.slice(
      src.indexOf('if (plan.kind === "text")'),
      src.indexOf('return "textWritten";'),
    );
    assert.ok(textArm.length > 0);
    assert.doesNotMatch(textArm, /gcsPath:/);
    assert.doesNotMatch(textArm, /mimeType:/);
    assert.match(textArm, /processingStatus: "READY"/);
    assert.match(textArm, /isEmbedded: false/);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. H2 — the re-fetch path the headers claimed and did not have              */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 H2: a blanked gcsPath is not automatically a dead end", () => {
  it("ICRA recovers from sourceUrl ALONE, with no bytes at all", () => {
    // The whole H2 finding: both migration headers said running order does not
    // matter "because the recovery re-fetches sourceUrl". No such branch
    // existed — `noBytes` returned immediately and the only fetch derives its
    // URL from the BODY. ICRA is the half that genuinely needs no bytes: the
    // rationale id is the `Id` parameter of sourceUrl.
    //
    // MUTATION: delete the `fromUrlAlone` block in `planRecovery` and this goes
    // RED while every other case stays green — 186 ICRA rows silently
    // unrecoverable behind a clean-looking `noBytes` census.
    const plan = planRecovery({
      sourceUrl: ICRA_URL,
      gcsPath: "",
      ...FRESH,
      body: null,
    });
    assert.equal(plan.outcome, "oneHopPlanned");
    assert.equal(
      plan.write?.kind === "one-hop" ? plan.write.url : "",
      "https://www.icra.in/Rating/ShowRationalReportFilePdf/139291",
    );
  });

  it("SEBI with no bytes is STILL noBytes — its link lives in the page", () => {
    // The asymmetry is the reason the quarantine needs an order GUARD and not
    // just a corrected sentence. Claiming SEBI recovers from the URL would be
    // the same false promise one level down.
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "",
      ...FRESH,
      body: null,
    });
    assert.equal(plan.outcome, "noBytes");
    assert.equal(plan.write, null);
  });

  it("a rating-agency page with no bytes is noBytes, not an empty extraction", () => {
    // `html-is-the-document` needs the bytes BY DEFINITION. Recovering "text"
    // from nothing would write an empty READY row, which is worse than the gap.
    const plan = planRecovery({
      sourceUrl: CRISIL_URL,
      gcsPath: "",
      ...FRESH,
      body: null,
    });
    assert.equal(plan.outcome, "noBytes");
    assert.equal(plan.write, null);
  });

  it("an unmeasured host with no bytes stays noBytes — nothing is guessed", () => {
    const plan = planRecovery({
      sourceUrl: "https://www.irb.co.in/investors/annual-report.html",
      gcsPath: "",
      ...FRESH,
      body: null,
    });
    assert.equal(plan.outcome, "noBytes");
  });
});

/* -------------------------------------------------------------------------- */
/* 7. H4 — the recovery's HTML set is a SUPERSET of the quarantine's           */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 H4: whatever the quarantine destroys, this job looks at", () => {
  /**
   * Head shapes that separate the two predicates. Measured over all 123,131
   * prod objects on 2026-09-02 the two disagree on 10, all in the SAFE
   * direction; these fixtures cover BOTH directions so the relationship is
   * pinned rather than the corpus.
   */
  const SHAPES: ReadonlyArray<[string, Buffer]> = [
    [
      "<?xml-stylesheet (NSE filing sidecar, MONEY-1319)",
      Buffer.from(
        `<?xml-stylesheet type="text/xsl" href="filing.xsl"?>\n<Filing><Symbol>ACME</Symbol></Filing>`,
        "utf-8",
      ),
    ],
    [
      "<!DOCTYPE with no `html` after it",
      Buffer.from(
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>`,
        "utf-8",
      ),
    ],
    [
      "a bare <title> (the 9 Acuité rows)",
      Buffer.from(
        `<title>Press Release</title><meta charset="UTF-8">`,
        "utf-8",
      ),
    ],
    [
      "a BOM before <!DOCTYPE html> (the knrcl.com row)",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`<!DOCTYPE html><html><body>x</body></html>`, "utf-8"),
      ]),
    ],
    ["an ordinary page", Buffer.from(`<!DOCTYPE html><html></html>`, "utf-8")],
  ];

  for (const [label, bytes] of SHAPES) {
    it(`${label}: quarantine-html implies recovery-acts`, () => {
      // THE INVARIANT, stated as an implication rather than as equality — the
      // two predicates answer deliberately different questions and live in
      // packages this migration cannot edit. What must never happen is the
      // quarantine blanking a gcsPath the recovery then walks past.
      //
      // MUTATION: drop the `sniffDocumentBody` arm from `bodyIsAWebPage` and
      // the `<?xml-stylesheet` case goes RED while the others stay green.
      const quarantineSaysHtml = sniffDocumentBody({
        key: "stocks/ACME/credit_rating/x.txt",
        size: bytes.length,
        head: bytes,
      }).html;
      const recoveryActs = bodyIsAWebPage(
        "stocks/ACME/credit_rating/x.txt",
        bytes,
      );
      if (quarantineSaysHtml) assert.ok(recoveryActs, label);
    });
  }

  it("`<?xml-stylesheet` is the case the two rules actually split on", () => {
    // A guard whose fixtures all agree proves nothing. This asserts the
    // DISAGREEMENT is real, so the implication above is not vacuous.
    const xsl = SHAPES[0]![1];
    assert.equal(
      sniffDocumentBody({ key: "k", size: xsl.length, head: xsl }).html,
      true,
      "archive-audit's rule matches <?xml-stylesheet",
    );
    assert.notEqual(
      sniffDocumentContainer(xsl),
      "html",
      "doc-container's rule does NOT — that is the whole gap",
    );
    assert.equal(bodyIsAWebPage("k", xsl), true, "the union closes it");
  });

  it("a real PDF is still notHtml under the union — idempotence survives", () => {
    // The superset must not swallow the property that makes a second run a
    // no-op rather than a second write.
    assert.equal(bodyIsAWebPage("stocks/ACME/drhp/x.pdf", A_REAL_PDF), false);
    const plan = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/x.pdf",
      ...FRESH,
      body: A_REAL_PDF,
    });
    assert.equal(plan.outcome, "notHtml");
  });

  it("a ZIP is notHtml — MONEY-1319's 179 NSE archives are not web pages", () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(200, 7),
    ]);
    assert.equal(bodyIsAWebPage("stocks/ACME/annual_report/x.pdf", zip), false);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. M13 — a GCS failure is a fault of the RUN, never a finding about a row   */
/* -------------------------------------------------------------------------- */

describe("MONEY-1321 M13: an auth failure cannot wear the noBytes costume", () => {
  it("readFailed is its OWN outcome, distinct from noBytes", () => {
    // MUTATION: restore the swallow (`catch { return null }` -> body null,
    // readFailed false) and this collapses into `noBytes` — a run that could
    // not open the bucket reports a clean census and exits 0.
    const failed = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/x.txt",
      ...FRESH,
      body: null,
      readFailed: true,
    });
    const absent = planRecovery({
      sourceUrl: SEBI_URL,
      gcsPath: "stocks/ACME/drhp/x.txt",
      ...FRESH,
      body: null,
    });
    assert.equal(failed.outcome, "readFailed");
    assert.equal(absent.outcome, "noBytes");
    assert.notEqual(failed.outcome, absent.outcome);
    assert.equal(failed.write, null, "a failed read must never plan a write");
  });

  it("readFailed beats even a URL-derivable recovery", () => {
    // ICRA recovers from sourceUrl alone, so this is the one row where a
    // swallowed error could still look productive. It must not: we do not know
    // what the object held, so we do not act on it.
    const plan = planRecovery({
      sourceUrl: ICRA_URL,
      gcsPath: "stocks/ACME/credit_rating/x.txt",
      ...FRESH,
      body: null,
      readFailed: true,
    });
    assert.equal(plan.outcome, "readFailed");
  });

  it("only 404 is `the object is not there`; everything else is a run fault", () => {
    assert.equal(isMissingObjectError({ code: 404 }), true);
    assert.equal(
      isMissingObjectError(new Error("No such object: stocks/x")),
      true,
    );
    assert.equal(isMissingObjectError({ code: 403 }), false);
    assert.equal(isMissingObjectError({ code: 401 }), false);
    assert.equal(isMissingObjectError({ code: 500 }), false);
    assert.equal(
      isMissingObjectError(new Error("Could not load the default credentials")),
      false,
      "an ADC failure is the exact shape that used to print as a clean run",
    );
    assert.equal(isMissingObjectError(new Error("ECONNRESET")), false);
    assert.equal(isMissingObjectError(null), false);
  });

  it("readFailed is a RUN FAULT, and the script exits non-zero on one", () => {
    assert.ok(RECOVERY_OUTCOMES.includes("readFailed"));
    assert.deepEqual([...RECOVERY_RUN_FAULTS], ["readFailed"]);
    const src = read("scripts/migrations/recover-html-stock-documents.ts");
    // The read must CLASSIFY rather than swallow.
    assert.doesNotMatch(
      src,
      /}\s*catch\s*{\s*return null;\s*}/,
      "a bare `catch { return null }` is the swallow this finding is about",
    );
    assert.match(src, /isMissingObjectError\(err\)/);
    assert.match(src, /process\.exitCode = 1/);
    // And the fault count must be printed even at zero, so an operator knows
    // the check ran.
    assert.match(src, /=== run health ===/);
  });
});
