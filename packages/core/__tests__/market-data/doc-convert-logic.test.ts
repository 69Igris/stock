/**
 * MONEY-1314 — routing from extraction output, never from the classifier.
 *
 * Every fixture below is a REAL shape measured from `stockbook-content-prod`
 * inside `node:20-alpine`, not an invention. The ones that matter most are the
 * documents that lie: `classifyPdf` reports TextBased at confidence 1.00 and
 * they extract to nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessExtraction,
  pageNeedsOcr,
  joinPagesToMarkdown,
  looksLikePdf,
  describeNonPdf,
  estimatePeakRssBytes,
  type ExtractedPage,
  sidecarIsPageIncomplete,
  SCANNED_SHARE_VISION_THRESHOLD,
} from "../../src/market-data/doc-convert-logic";

/** A born-digital page. */
const text = (page: number, md = "| Revenue | 1,000 |"): ExtractedPage => ({
  page,
  markdown: md,
  needsOcr: false,
});

/** A GENUINE scan — carries `ocrReason`. */
const scan = (page: number): ExtractedPage => ({
  page,
  markdown: "",
  needsOcr: true,
  ocrReason: "scanned",
});

/**
 * A GARBAGE-TEXT-LAYER scan — the population that breaks the classifier.
 * Note the object has NO `ocrReason` key at all: measured keys are exactly
 * ["page","markdown","needsOcr"].
 */
const garbage = (page: number): ExtractedPage => ({
  page,
  markdown: "",
  needsOcr: true,
});

describe("MONEY-1314 — the classifier lies, extraction does not", () => {
  it("a document that classifies TextBased/1.00 but extracts nothing is SCANNED_ONLY", () => {
    // ZGAEKWAR, ZNILKENG, ENBETRD, PADAMCO, BRAHMINFRA — five of twenty-two
    // documents, four of them BSE quarterly_result, which is 30,956 rows and
    // the largest docType in the archive. classifyPdf said
    // { pdfType: "TextBased", confidence: 1.00, pagesNeedingOcr: [] }.
    const pages = [0, 1, 2, 3, 4, 5].map(garbage);
    const a = assessExtraction(pages);
    assert.equal(a.status, "SCANNED_ONLY");
    assert.equal(a.textPageCount, 0);
    assert.equal(a.scannedPageCount, 6);
  });

  it("[control] a genuinely text-bearing document is CONVERTED", () => {
    // Proves the assessment discriminates rather than answering SCANNED_ONLY
    // to everything — which would pass the assertion above while sending the
    // entire corpus to the vision lane.
    const a = assessExtraction([0, 1, 2].map((p) => text(p)));
    assert.equal(a.status, "CONVERTED");
    assert.equal(a.textPageCount, 3);
    assert.equal(a.scannedPageCount, 0);
  });

  it("a MIXED document is CONVERTED — one scanned page does not reject 340 good ones", () => {
    // The rule that disqualified `anydoc` as the converter: it rejects a whole
    // 341-page document because one page is a scan. AXISBANK's real annual
    // report is 554 pages with 10 needing OCR.
    const pages = [
      ...Array.from({ length: 20 }, (_, i) => text(i)),
      scan(20),
      scan(21),
    ];
    const a = assessExtraction(pages);
    assert.equal(a.status, "CONVERTED");
    assert.equal(a.textPageCount, 20);
    assert.equal(a.scannedPageCount, 2);
  });

  it("an empty extraction is FAILED, distinct from SCANNED_ONLY", () => {
    // "the library returned nothing" and "every page needs OCR" call for
    // different actions: the first is a retry, the second is Document AI.
    const a = assessExtraction([]);
    assert.equal(a.status, "FAILED");
    assert.equal(a.totalPageCount, 0);
  });
});

describe("MONEY-1314 — the index-base trap", () => {
  it("ocrPageNumbers are 1-INDEXED even though pages[].page is 0-indexed", () => {
    // Verified on a 26-page document: classifyPdf().pagesNeedingOcr = [0…25],
    // extractPagesMarkdown().pagesNeedingOcr = [1…26], pages[].page = [0…25].
    // Two of those share a field NAME. Crossing them sends the WRONG PAGE to
    // Document AI — off by one, silently, returning a real OCR result for a
    // page nobody asked about.
    const a = assessExtraction([text(0), scan(1), text(2), scan(3)]);
    assert.deepEqual(a.ocrPageNumbers, [2, 4]);
    assert.ok(
      !a.ocrPageNumbers.includes(0),
      "a 0 here means the 0-indexed page number leaked through unconverted",
    );
  });

  it("[control] the 0-indexed input is what produced those numbers", () => {
    // Without this, an implementation that ignored `page` entirely and emitted
    // 1..n would satisfy the assertion above.
    const a = assessExtraction([scan(7)]);
    assert.deepEqual(a.ocrPageNumbers, [8]);
  });
});

describe("MONEY-1314 — the shapes that defeat a null check", () => {
  it('an OCR-bound page carries markdown "", never null', () => {
    // `md ?? null` and `md === null` both never fire on real data. The test is
    // emptiness, and it must be on TRIMMED text.
    assert.equal(pageNeedsOcr({ page: 0, markdown: "", needsOcr: true }), true);
    assert.equal(
      pageNeedsOcr({ page: 0, markdown: "   \n\t ", needsOcr: false }),
      true,
      "whitespace-only markdown is not text, whatever the flag says",
    );
  });

  it("ocrReason may be ABSENT — never gate on its presence", () => {
    // Genuine scans carry ocrReason:"scanned"; garbage-text-layer scans do not
    // carry the key at all. A gate on the reason misses exactly the population
    // this module exists for.
    assert.equal(pageNeedsOcr(garbage(0)), true);
    assert.equal(pageNeedsOcr(scan(0)), true);
  });

  it("[control] a real text page is NOT flagged", () => {
    assert.equal(pageNeedsOcr(text(0)), false);
  });

  it("the empty-markdown witness works even if needsOcr stops being set", () => {
    // Independent second witness: a future library revision that stops setting
    // the flag must not silently reopen the hole.
    assert.equal(
      pageNeedsOcr({ page: 0, markdown: "", needsOcr: false }),
      true,
    );
  });
});

describe("MONEY-1314 — joining pages", () => {
  it("emits 1-indexed page markers and drops OCR-bound pages", () => {
    const md = joinPagesToMarkdown([text(0, "A"), scan(1), text(2, "C")]);
    assert.ok(md.includes("<!-- page 1 -->"));
    assert.ok(md.includes("<!-- page 3 -->"));
    assert.ok(
      !md.includes("<!-- page 2 -->"),
      "a scanned page contributed a marker",
    );
    assert.ok(md.includes("A") && md.includes("C"));
  });

  it("markers exist because the schema asks the model to cite pages", () => {
    // A concatenation with no markers makes `pageRefs` unanswerable, and the
    // model will invent them rather than leave them null.
    const md = joinPagesToMarkdown([text(41, "X")]);
    assert.match(md, /<!-- page 42 -->/);
  });
});

describe("MONEY-1314 — objects that are not PDFs at all", () => {
  it("recognises the four corrupt shapes found in the archive", () => {
    // FOUR of the six largest objects sampled are not PDFs, all stored under
    // mimeType "application/pdf" with plausible metadata.
    const zip = Buffer.from("PK\x03\x04\x14\x00\x00\x00", "latin1");
    assert.equal(looksLikePdf(zip), false);
    assert.match(describeNonPdf(zip), /ZIP/);

    const multipart = Buffer.from(
      "--cca43fa3-1234-5678\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}",
      "latin1",
    );
    assert.equal(looksLikePdf(multipart), false);
    assert.match(describeNonPdf(multipart), /multipart/);

    const json = Buffer.from('{"kind":"storage#object"}', "latin1");
    assert.equal(looksLikePdf(json), false);
    assert.match(describeNonPdf(json), /JSON/);

    const html = Buffer.from("<!DOCTYPE html><html>", "latin1");
    assert.equal(looksLikePdf(html), false);
  });

  it("[control] a real PDF header passes, including with leading bytes", () => {
    assert.equal(looksLikePdf(Buffer.from("%PDF-1.7\n%âãÏÓ", "latin1")), true);
    // The spec allows the header within the first 1024 bytes.
    assert.equal(
      looksLikePdf(Buffer.from("   \n\r%PDF-1.4\n", "latin1")),
      true,
    );
  });

  it("a TRUNCATED PDF still passes the magic-byte check — and that is correct", () => {
    // AKASH FY2025: 118.73 MB, last %%EOF at byte 1,381,340 of 124,499,188,
    // file ends mid-stream. Magic bytes cannot see truncation; the library's
    // "Invalid PDF structure" does. Claiming otherwise here would be a guard
    // that appears to cover a case it cannot.
    assert.equal(
      looksLikePdf(Buffer.from("%PDF-1.5\n<< /Type", "latin1")),
      true,
    );
  });

  it("a buffer shorter than the magic string is refused, not crashed", () => {
    assert.equal(looksLikePdf(Buffer.from("%PD", "latin1")), false);
    assert.equal(looksLikePdf(Buffer.alloc(0)), false);
  });
});

describe("MONEY-1314 — memory sizing is measured, not guessed", () => {
  it("the 129.81 MB document's estimate covers its measured 618 MB peak", () => {
    // The single worst observation in the sample. If the multiplier is ever
    // lowered, this fails by name rather than as an OOM in production.
    const bytes = 129.81 * 1024 * 1024;
    assert.ok(
      estimatePeakRssBytes(bytes) >= 618 * 1024 * 1024,
      `estimate ${Math.round(estimatePeakRssBytes(bytes) / 1e6)} MB does not ` +
        "cover the 618 MB actually measured for a 129.81 MB PDF",
    );
  });

  it("a 512 MiB instance is shown to be too small for a 100 MB document", () => {
    // 109 objects in the archive exceed 40 MB. This is why the ingest worker
    // ships with 2 GiB and not the default.
    assert.ok(estimatePeakRssBytes(100 * 1024 * 1024) > 512 * 1024 * 1024);
  });

  it("an unknown or absurd size falls back to the floor rather than NaN", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const v = estimatePeakRssBytes(bad);
      assert.ok(Number.isFinite(v) && v > 0, `${bad} produced ${v}`);
    }
  });
});

/**
 * PAGE-COMPLETENESS ROUTING — MONEY-1334.
 *
 * `assessExtraction` calls a MIXED document CONVERTED, which is correct for
 * CONVERSION and insufficient for READING: pages that produced no text are
 * simply absent from the sidecar, and when the financial statements are among
 * them a text read answers honestly about what remains and returns null for
 * every column it never saw.
 *
 * Each case below is a REAL prod document with a known outcome, so the table is
 * evidence rather than illustration.
 */
describe("MONEY-1334 — a sidecar missing pages is not a complete reading", () => {
  /** (label, scanned, text, expectIncomplete) — all measured 2026-09-03. */
  const MEASURED: ReadonlyArray<[string, number, number, boolean]> = [
    // Broken: statements were among the pages that produced no text.
    ["GOYALALUM FY2024 — parse FAILED outright, 0 periods", 67, 67, true],
    ["GOYALALUM FY2023 — 17 balance-sheet columns null", 50, 64, true],
    ["BONLON FY2025 — pages 92-135 absent, the statement block", 45, 111, true],
    // Healthy: a complete page set.
    ["GOYALALUM FY2020 — clean, 0 missing columns", 1, 67, false],
    // The SECOND failure mode, which this rule deliberately does NOT claim.
    ["AHLWEST FY2024 — 28 null with a COMPLETE page set", 1, 134, false],
    ["HARDWYN FY2025 — 12 null with a COMPLETE page set", 0, 145, false],
  ];

  for (const [label, scanned, text, expected] of MEASURED) {
    it(`${expected ? "routes to vision" : "reads the sidecar"}: ${label}`, () => {
      const verdict = sidecarIsPageIncomplete({
        scannedPageCount: scanned,
        textPageCount: text,
      });
      assert.equal(
        verdict.incomplete,
        expected,
        `${scanned}/${scanned + text} pages produced no text ` +
          `(${((scanned / (scanned + text)) * 100).toFixed(0)}%)`,
      );
    });
  }

  it("does not claim the second failure mode, which has NO page signal", () => {
    // HARDWYN loses 12 columns at 0% scanned. Lowering the threshold cannot
    // reach it — there is nothing missing for a page-completeness rule to
    // detect — and a future edit that lowers it to chase these documents would
    // route half the corpus to the expensive lane and still not fix them.
    const hardwyn = sidecarIsPageIncomplete({
      scannedPageCount: 0,
      textPageCount: 145,
    });
    assert.equal(hardwyn.scannedShare, 0);
    assert.equal(hardwyn.incomplete, false);
  });

  it("treats an UNKNOWN page count as complete, never as incomplete", () => {
    // Absent counters predate the columns. An absent measurement is not
    // evidence of incompleteness, and reading it as such would route the whole
    // pre-MONEY-1314 corpus to vision.
    for (const doc of [
      { scannedPageCount: null, textPageCount: null },
      { scannedPageCount: null, textPageCount: 100 },
      { scannedPageCount: 5, textPageCount: null },
      { scannedPageCount: 0, textPageCount: 0 },
    ]) {
      const verdict = sidecarIsPageIncomplete(doc);
      assert.equal(verdict.incomplete, false);
      assert.equal(verdict.scannedShare, null);
    }
  });

  it("measures the share of the WHOLE document, not a ratio to text pages", () => {
    // Mutation-driven. `scanned / text` agrees with `scanned / (scanned+text)`
    // on every measured document, so the six cases above cannot tell the two
    // denominators apart — they only diverge between 0.2*text and 0.25*text.
    // Both halves matter: the value is reported to operators in a log line, and
    // the wrong denominator silently overstates every document's scan share.
    const bonlon = sidecarIsPageIncomplete({
      scannedPageCount: 45,
      textPageCount: 111,
    });
    assert.ok(
      Math.abs((bonlon.scannedShare ?? 0) - 45 / 156) < 1e-9,
      `BONLON share ${bonlon.scannedShare} is not 45/156 — wrong denominator`,
    );

    // Squarely inside the divergent band: 22/(22+100) = 18% is COMPLETE, while
    // 22/100 = 22% would cross the threshold and route it to vision.
    const inBand = sidecarIsPageIncomplete({
      scannedPageCount: 22,
      textPageCount: 100,
    });
    assert.equal(
      inBand.incomplete,
      false,
      "22 of 122 pages is 18% of the document — a text-page ratio would " +
        "read it as 22% and send a readable document to the costly lane",
    );
  });

  it("sits strictly between the observed healthy and broken classes", () => {
    // The threshold is n=4 evidence, so this asserts the RELATIONSHIP it has to
    // preserve rather than the literal: above the worst healthy document (1%)
    // and at-or-below the least-scanned broken one (BONLON, 45/156 = 28.8%).
    const worstHealthy = 1 / 68;
    const leastBroken = 45 / 156;
    assert.ok(
      SCANNED_SHARE_VISION_THRESHOLD > worstHealthy,
      "threshold would route a document measured healthy to the costly lane",
    );
    assert.ok(
      SCANNED_SHARE_VISION_THRESHOLD <= leastBroken,
      "threshold would miss BONLON FY2025, whose statement block is absent",
    );
  });
});
