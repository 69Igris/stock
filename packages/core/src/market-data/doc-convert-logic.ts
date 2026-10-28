/**
 * Turning `@firecrawl/pdf-inspector` output into a routing decision — MONEY-1314.
 *
 * PURE. No I/O, no library import — the caller passes the shapes the library
 * returned. That is deliberate: the rules below were derived by MEASURING 26
 * real filings (1,816 pages) from `stockbook-content-prod` inside
 * `node:20-alpine`, and every one of them exists because the obvious version
 * was wrong on real data. That measurement stands as taken; the workers image
 * has run `node:22-alpine` since MONEY-1373 (the Databento `.csv.zst` stream
 * needs `zlib.createZstdDecompress`, Node >= 22.15). The SAME musl prebuild
 * serves both — `@firecrawl/pdf-inspector`'s linux-musl binary is N-API and so
 * is ABI-stable across Node majors — which is why the findings below were not
 * re-measured, and why the bump was verified by requiring the module inside the
 * built image rather than by trusting that property.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE BLOCKING FINDING: `classifyPdf` IS NOT A ROUTER
 * ═══════════════════════════════════════════════════════════════════════
 *
 * FIVE of twenty-two documents classify as:
 *
 *     { pdfType: "TextBased", confidence: 1.00, pagesNeedingOcr: [] }
 *
 * and then extract to ZERO CHARACTERS, with `extractPagesMarkdown` flagging
 * EVERY page as OCR-bound. Not a low-confidence guess — full confidence, and
 * wrong.
 *
 * The cause is that these are scans carrying a GARBAGE OCR text layer.
 * `extractText` on one of them returns 9,567 characters reading
 * `ecu—"4m,<wr.w."m..'.V...'1.,THEGAEKWARMILLSLTD...`. `classifyPdf` sees a
 * text layer and believes it; `extractPagesMarkdown` applies a quality gate
 * and rejects it.
 *
 * FOUR OF THE FIVE ARE BSE `quarterly_result` — 30,956 rows, the largest
 * docType in the archive. So this is not an edge case, it is the dominant
 * population, and routing on `classifyPdf` would send tens of thousands of
 * documents to a lane that produces nothing.
 *
 * Hence: the text/scanned decision is taken from EXTRACTION OUTPUT ONLY.
 * `classifyPdf` may be used as a cheap pre-filter for logging; it may never
 * decide a lane.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE INDEX-BASE TRAP
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Three page numberings are in play and two share a field NAME:
 *
 *     classifyPdf().pagesNeedingOcr          0-INDEXED
 *     extractPagesMarkdown().pagesNeedingOcr 1-INDEXED
 *     extractPagesMarkdown().pages[].page    0-INDEXED
 *
 * Verified on a 26-page document: classify said [0…25], extract said [1…26],
 * `pages[].page` said [0…25]. Crossing them sends the WRONG PAGE to Document
 * AI — off by one, silently, producing a real OCR result for a page nobody
 * asked about. Everything this module emits is 1-INDEXED and says so in its
 * name.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TWO SHAPES THAT DEFEAT THE OBVIOUS NULL CHECK
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   - an OCR-bound page returns `markdown: ""`, an EMPTY STRING, never `null`
 *     or `undefined`. `md ?? null` and `md === null` both never fire.
 *   - `ocrReason` is ABSENT FROM THE OBJECT on the garbage-text-layer scans
 *     (keys are exactly `["page","markdown","needsOcr"]`), while genuine scans
 *     do carry `ocrReason: "scanned"`. So a gate on the reason being present
 *     misses precisely the population this module exists for.
 */

/** One page as `extractPagesMarkdownAsync` returns it. */
export interface ExtractedPage {
  /** 0-INDEXED, as the library emits it. */
  page: number;
  /** `""` — never null — when the page needs OCR. */
  markdown: string;
  needsOcr: boolean;
  /** ABSENT on garbage-text-layer scans. Never gate on its presence. */
  ocrReason?: string;
}

export interface ConvertAssessment {
  /** Pages that yielded usable text. */
  textPageCount: number;
  /** Pages that need OCR — by the REAL test, not the library's flag alone. */
  scannedPageCount: number;
  totalPageCount: number;
  /** 1-INDEXED, normalised. Safe to hand to Document AI. */
  ocrPageNumbers: number[];
  /**
   * CONVERTED (some usable text) | SCANNED_ONLY (none) | FAILED (no pages).
   * Mirrors `CONVERT_STATUS` in the workers' selector module.
   */
  status: "CONVERTED" | "SCANNED_ONLY" | "FAILED";
}

/**
 * Above this share of OCR-needing pages, a sidecar is not trusted to be a
 * COMPLETE reading of the document — MONEY-1334.
 *
 * `assessExtraction` deliberately calls a MIXED document CONVERTED, and that is
 * right for conversion (three scanned signature pages must not reject a
 * 341-page report). It is NOT sufficient for READING: the pages that produced
 * no text are simply absent from the sidecar, and if the financial statements
 * are among them, a text read answers honestly about what remains and returns
 * null for every column it never saw.
 *
 * MEASURED on prod 2026-09-03 (7 pilot documents with known outcomes):
 *
 *   50%  GOYALALUM FY2024  parse FAILED outright, 0 periods
 *   44%  GOYALALUM FY2023  17 balance-sheet columns null
 *   29%  BONLON    FY2025  pages 92-135 absent — exactly the statement block
 *    1%  GOYALALUM FY2020  clean, 0 missing columns
 *
 * 20% sits between the observed classes. It is a STARTING POINT ON n=4, not a
 * derived constant, and it is exported so the 200-document pilot can move it
 * with real evidence rather than by argument. Cost of the choice, measured
 * across the 32,893 CONVERTED documents: >=20% routes 5,003 (15.2%) to vision,
 * >=10% routes 10,835 (32.9%), >=5% routes 15,655 (47.6%).
 *
 * DOES NOT COVER a second, independent failure: HARDWYN FY2025 (0% scanned, 12
 * columns null) and AHLWEST FY2024 (1% scanned, 28 null) lose figures with a
 * complete page set — table structure, not missing pages. No signal for that
 * one is known yet, and this threshold must not be lowered to chase it: at 0%
 * there is nothing for a page-completeness rule to detect.
 */
export const SCANNED_SHARE_VISION_THRESHOLD = 0.2;

/**
 * Should this document be READ through vision rather than its markdown sidecar?
 *
 * Pure, and deliberately fed from the counters the converter already stamped
 * (`scannedPageCount` / `textPageCount`) rather than from the sidecar text.
 * Three text-based detectors were built and measured against these same
 * documents first, and all three failed: statement-HEADING detection returns
 * empty for every real sidecar (the converter emits `# <u>CONTENTS</u>`, not
 * `## Balance Sheet`), and label-with-a-number greps neither separate the
 * classes nor survive GOYALALUM FY2023, whose only numeric "Total Assets" is an
 * AOC-1 annex describing a DIFFERENT legal entity.
 *
 * Unknown counters (null on rows written before the columns existed) return
 * false: an absent measurement is not evidence of incompleteness, and treating
 * it as such would route the entire pre-MONEY-1314 corpus to the expensive lane.
 */
export function sidecarIsPageIncomplete(doc: {
  scannedPageCount: number | null;
  textPageCount: number | null;
}): { incomplete: boolean; scannedShare: number | null } {
  const scanned = doc.scannedPageCount;
  const text = doc.textPageCount;
  if (scanned === null || text === null) {
    return { incomplete: false, scannedShare: null };
  }
  const total = scanned + text;
  if (total <= 0) return { incomplete: false, scannedShare: null };
  const scannedShare = scanned / total;
  return {
    incomplete: scannedShare >= SCANNED_SHARE_VISION_THRESHOLD,
    scannedShare,
  };
}

/**
 * Is this page's text usable?
 *
 * `needsOcr` OR empty markdown. The second clause is the one that catches the
 * garbage-text-layer population: those pages arrive with `needsOcr: true` from
 * `extractPagesMarkdown` (which is why extraction is the authority), but the
 * empty-string test is kept as an independent witness so a future library
 * revision that stops setting the flag cannot silently reopen the hole.
 */
export function pageNeedsOcr(page: ExtractedPage): boolean {
  return page.needsOcr === true || page.markdown.trim() === "";
}

/**
 * Assess an extraction result.
 *
 * NOTE the emptiness test is on TRIMMED markdown. A page of whitespace is not
 * text, and a converter that emitted `"\n\n"` for a blank page would otherwise
 * count it toward `textPageCount` and make a fully-scanned document look
 * partially readable.
 */
export function assessExtraction(
  pages: readonly ExtractedPage[],
): ConvertAssessment {
  if (pages.length === 0) {
    return {
      textPageCount: 0,
      scannedPageCount: 0,
      totalPageCount: 0,
      ocrPageNumbers: [],
      status: "FAILED",
    };
  }

  const ocrPageNumbers: number[] = [];
  let textPageCount = 0;

  for (const p of pages) {
    if (pageNeedsOcr(p)) {
      // +1: `pages[].page` is 0-indexed and everything we emit is 1-indexed.
      ocrPageNumbers.push(p.page + 1);
    } else {
      textPageCount++;
    }
  }

  return {
    textPageCount,
    scannedPageCount: ocrPageNumbers.length,
    totalPageCount: pages.length,
    ocrPageNumbers,
    // A MIXED document is CONVERTED, not SCANNED_ONLY. A born-digital annual
    // report with three scanned signature pages is fully readable through
    // markdown, and this is exactly the rule that disqualified `anydoc` as a
    // converter: it rejects a whole 341-page document because one page is a
    // scan.
    status: textPageCount > 0 ? "CONVERTED" : "SCANNED_ONLY",
  };
}

/**
 * Assemble one markdown document from the readable pages.
 *
 * Page markers are emitted because the extraction schema asks the model to
 * cite the page each statement came from, and a concatenation with no markers
 * makes that impossible to answer honestly. They are 1-INDEXED for the same
 * reason everything else here is.
 */
export function joinPagesToMarkdown(pages: readonly ExtractedPage[]): string {
  return pages
    .filter((p) => !pageNeedsOcr(p))
    .map((p) => `\n\n<!-- page ${p.page + 1} -->\n\n${p.markdown.trim()}`)
    .join("")
    .trim();
}

/**
 * The RSS a conversion is likely to peak at, from the object's size.
 *
 * MEASURED, not assumed: peak resident memory ran **2.3x to 4.8x file size**
 * across the sample, worst case 618 MB for a 129.81 MB PDF. Node's own floor
 * is ~68 MB, which is why small documents show an absurd MB-per-page figure
 * and why page count is the wrong basis for this estimate.
 *
 * The consequence for deployment: a 512 MiB instance dies on any file over
 * ~100 MB, and 109 objects in the archive exceed 40 MB. The ingest worker
 * needs 1 GiB minimum and ships with 2 GiB.
 */
export const CONVERT_RSS_MULTIPLIER = 4.8;
export const NODE_RSS_FLOOR_BYTES = 68 * 1024 * 1024;

export function estimatePeakRssBytes(fileBytes: number): number {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0)
    return NODE_RSS_FLOOR_BYTES;
  return NODE_RSS_FLOOR_BYTES + fileBytes * CONVERT_RSS_MULTIPLIER;
}

/**
 * Is this object actually a PDF?
 *
 * MEASURED: FOUR of the six largest objects sampled are not PDFs at all, and
 * they are stored under `mimeType: "application/pdf"` with plausible metadata:
 *
 *   212.03 MB  a raw GCS multipart/related UPLOAD ENVELOPE, stored verbatim
 *              (`--cca43fa3-…\r\nContent-Type: application/json…`)
 *   135.34 MB  the same envelope
 *   118.73 MB  a TRUNCATED PDF — last %%EOF at byte 1,381,340 of 124,499,188
 *    90.98 MB  a ZIP archive (starts `PK`)
 *
 * Checking the first bytes costs nothing and prevents spending a Document AI
 * call, a Gemini upload, or 618 MB of RSS on a file that cannot parse. The
 * ingest worker rejects these BEFORE any of that, and the archive-health
 * question — how many more there are, and whether they can be re-fetched — is
 * its own ticket rather than something this lane silently absorbs.
 */
export const PDF_MAGIC = "%PDF-";

export function looksLikePdf(head: Buffer | Uint8Array): boolean {
  if (head.length < PDF_MAGIC.length) return false;
  // Some producers emit leading whitespace or a BOM before %PDF-; the spec
  // allows the header within the first 1024 bytes, so scan rather than compare
  // at offset 0.
  const window = Buffer.from(
    head.subarray(0, Math.min(head.length, 1024)),
  ).toString("latin1");
  return window.includes(PDF_MAGIC);
}

/** Why a non-PDF was rejected, for the outcome report. */
export function describeNonPdf(head: Buffer | Uint8Array): string {
  const s = Buffer.from(head.subarray(0, Math.min(head.length, 256))).toString(
    "latin1",
  );
  if (s.startsWith("PK")) return "ZIP archive stored as application/pdf";
  if (/^--[\w-]+\r?\nContent-Type:/.test(s)) {
    return "raw multipart/related upload envelope stored verbatim";
  }
  if (/^\s*[{[]/.test(s)) return "JSON stored as application/pdf";
  if (/^\s*</.test(s)) return "HTML/XML stored as application/pdf";
  return "no %PDF- header in the first 1024 bytes";
}
