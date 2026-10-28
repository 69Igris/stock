/**
 * Stock Document Embedding Processor Tests
 * (workers/src/processors/stock-document-embed.ts) — DE-SHADOWED.
 *
 * Previously this file re-declared inline copies of `chunkText`, the whole
 * section-aware `chunkFinancialText`, `SECTION_HEADERS`, the constants,
 * `buildEmbedQuery` and `shouldSkipDocument`, and asserted the copies. That was
 * a SHADOW — and it had already DRIFTED: the inline copy prefixed chunks with an
 * em-dash ("{SYMBOL} — {section}") whereas the REAL processor uses a hyphen
 * ("{SYMBOL} - {section}"). A green shadow was therefore "verifying" output the
 * real pipeline never produces.
 *
 * The chunker + query builder + constants now live in
 * `workers/src/processors/stock-document-embed-logic.ts`, which
 * `stock-document-embed.ts` imports and CALLS; this test asserts the REAL
 * exports (and pins the real hyphen prefix).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker source under test (no shadow).
import {
  SYSTEM_USER_ID,
  DELAY_BETWEEN_BATCHES_MS,
  MAX_CHUNK_TOKENS,
  MAX_CHUNKS_PER_DOC,
  SECTION_HEADERS,
  CONCALL_TURNS_PER_CHUNK,
  ANNUAL_REPORT_HEADINGS,
  capChunks,
  chunkFinancialText,
  chunkConcallTranscript,
  chunkAnnualReport,
  chunkByDocType,
  buildEmbedQuery,
  shouldSkipDocument,
  embedGcsBucket,
  gcsUriForDocument,
} from "../../../../workers/src/processors/stock-document-embed-logic";

describe("Workers - Processor: Stock Document Embed", () => {
  // ── Constants (real exports) ─────────────────────────────────────

  describe("Constants (real exports)", () => {
    it("SYSTEM_USER_ID is a 24-char MongoDB ObjectId-like string", () => {
      assert.strictEqual(SYSTEM_USER_ID.length, 24);
      assert.strictEqual(SYSTEM_USER_ID, "000000000000000000000001");
    });

    it("DELAY_BETWEEN_BATCHES_MS is 1000", () => {
      assert.strictEqual(DELAY_BETWEEN_BATCHES_MS, 1000);
    });

    it("MAX_CHUNK_TOKENS is 512", () => {
      assert.strictEqual(MAX_CHUNK_TOKENS, 512);
    });

    it("SECTION_HEADERS contains all expected financial sections", () => {
      assert.ok(SECTION_HEADERS.includes("Income Statement"));
      assert.ok(SECTION_HEADERS.includes("Balance Sheet"));
      assert.ok(SECTION_HEADERS.includes("Cash Flow Statement"));
      assert.ok(SECTION_HEADERS.includes("Profit & Loss"));
      assert.ok(SECTION_HEADERS.includes("Key Ratios"));
      assert.ok(SECTION_HEADERS.includes("Quarterly Results"));
      assert.ok(SECTION_HEADERS.includes("Shareholding Pattern"));
    });

    it("SECTION_HEADERS has 16 entries", () => {
      assert.strictEqual(SECTION_HEADERS.length, 16);
    });
  });

  // ── chunkFinancialText (real export) ─────────────────────────────

  describe("chunkFinancialText (real export)", () => {
    it("falls back to generic chunking when no section headers found", () => {
      const text =
        "This is plain text with no financial sections. It has enough data to be processed.";
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(chunks.length >= 1);
      assert.ok(chunks[0]!.text.startsWith("TCS\n\n"));
    });

    it("splits at known section headers", () => {
      const text =
        "Income Statement\nRevenue: 1000\nExpenses: 500\n\n" +
        "Balance Sheet\nAssets: 5000\nLiabilities: 2000\n";
      const chunks = chunkFinancialText(text, "RELIANCE");
      assert.ok(chunks.length >= 2);
      assert.ok(chunks[0]!.text.includes("Income Statement"));
      assert.ok(chunks[1]!.text.includes("Balance Sheet"));
    });

    it("prefixes each chunk with '{SYMBOL} - {section}' (real HYPHEN, not em-dash)", () => {
      const text =
        "Income Statement\nRevenue: 1000\nExpenses: 500\n\n" +
        "Balance Sheet\nAssets: 5000\nLiabilities: 2000\n";
      const chunks = chunkFinancialText(text, "INFY");
      assert.ok(chunks[0]!.text.startsWith("INFY - Income Statement"));
      assert.ok(chunks[1]!.text.startsWith("INFY - Balance Sheet"));
      // The drifted shadow used "—"; assert the real pipeline never does.
      assert.ok(!chunks[0]!.text.includes("—"));
    });

    it("assigns sequential chunkIndex values", () => {
      const text =
        "Income Statement\nRevenue: 1000\n\n" +
        "Balance Sheet\nAssets: 5000\n\n" +
        "Cash Flow Statement\nOperating: 300\n";
      const chunks = chunkFinancialText(text, "TCS");
      for (let i = 0; i < chunks.length; i++) {
        assert.strictEqual(chunks[i]!.chunkIndex, i);
      }
    });

    it("extracts preamble as an Overview section when > 50 chars", () => {
      const preamble = "A".repeat(60);
      const text = `${preamble}\nIncome Statement\nRevenue: 1000\nExpenses: 500\n`;
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(chunks[0]!.text.includes("Overview"));
    });

    it("skips preamble when <= 50 chars", () => {
      const text = `Short preamble\nIncome Statement\nRevenue: 1000\nExpenses: 500\n`;
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(!chunks[0]!.text.includes("Overview"));
      assert.ok(chunks[0]!.text.includes("Income Statement"));
    });

    it("skips sections with content <= 30 chars", () => {
      const text =
        "Income Statement\nA\n\n" +
        "Balance Sheet\nAssets: 5000\nLiabilities: 2000\nEquity: 3000\n";
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(chunks.length >= 1);
      assert.ok(chunks[0]!.text.includes("Balance Sheet"));
    });

    it("sub-chunks large sections with part numbers", () => {
      const maxChars = MAX_CHUNK_TOKENS * 4;
      const largeContent = "X".repeat(maxChars + 500);
      const text = `Income Statement\n${largeContent}`;
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(chunks.length > 1);
      assert.ok(chunks[0]!.text.includes("(part 1)"));
      assert.ok(chunks[1]!.text.includes("(part 2)"));
    });

    it("matches section headers case-insensitively", () => {
      const text = "income statement\nRevenue: 1000\nExpenses: 500\n";
      const chunks = chunkFinancialText(text, "TCS");
      assert.ok(chunks.length >= 1);
      assert.ok(chunks[0]!.text.includes("income statement"));
    });

    it("handles multiple distinct section headers", () => {
      const text =
        "Quarterly Results\nQ1: Revenue 100\nProfit 20\n\n" +
        "Shareholding Pattern\nPromoter: 50%\nFII: 25%\nDII: 15%\n";
      const chunks = chunkFinancialText(text, "HDFC");
      assert.strictEqual(chunks.length, 2);
      assert.ok(chunks[0]!.text.includes("Quarterly Results"));
      assert.ok(chunks[1]!.text.includes("Shareholding Pattern"));
    });
  });

  // ── buildEmbedQuery (real export) ────────────────────────────────

  describe("buildEmbedQuery (real export)", () => {
    it("always includes processingStatus=READY and textContent not null", () => {
      const q = buildEmbedQuery({});
      assert.strictEqual(q.processingStatus, "READY");
      assert.deepStrictEqual(q.textContent, { not: null });
    });

    it("sets isEmbedded=false when forceReindex is falsy", () => {
      assert.strictEqual(
        buildEmbedQuery({ forceReindex: false }).isEmbedded,
        false
      );
    });

    it("omits isEmbedded when forceReindex is true", () => {
      assert.strictEqual(
        "isEmbedded" in buildEmbedQuery({ forceReindex: true }),
        false
      );
    });

    it("adds an uppercased symbol filter when symbols are provided", () => {
      assert.deepStrictEqual(
        buildEmbedQuery({ symbols: ["tcs", "infy"] }).symbol,
        {
          in: ["TCS", "INFY"],
        }
      );
    });

    it("omits the symbol filter when symbols is empty", () => {
      assert.strictEqual("symbol" in buildEmbedQuery({ symbols: [] }), false);
    });

    it("adds a docType filter when docTypes are provided", () => {
      assert.deepStrictEqual(
        buildEmbedQuery({ docTypes: ["financial_statement", "annual_report"] })
          .docType,
        { in: ["financial_statement", "annual_report"] }
      );
    });
  });

  // ── shouldSkipDocument (real export) ─────────────────────────────

  describe("shouldSkipDocument (real export)", () => {
    it("skips null / undefined text", () => {
      assert.strictEqual(shouldSkipDocument(null), true);
      assert.strictEqual(shouldSkipDocument(undefined), true);
    });

    it("skips text shorter than 50 chars", () => {
      assert.strictEqual(shouldSkipDocument("too short"), true);
      assert.strictEqual(shouldSkipDocument("A".repeat(49)), true);
    });

    it("keeps text of 50+ chars", () => {
      assert.strictEqual(shouldSkipDocument("A".repeat(50)), false);
    });
  });

  // ── Per-docType chunkers (MONEY-784 P3b) ─────────────────────────

  describe("chunkConcallTranscript (real export)", () => {
    it("CONCALL_TURNS_PER_CHUNK is 4", () => {
      assert.strictEqual(CONCALL_TURNS_PER_CHUNK, 4);
    });

    it("splits on speaker turns and groups them per chunk", () => {
      const text = [
        "Moderator: Welcome to the Q3 earnings call.",
        "Ramesh Kumar: Thank you. Revenue grew 18% this quarter.",
        "Analyst: What drove the margin expansion?",
        "Ramesh Kumar: Operating leverage and a better product mix.",
        "Analyst: And the outlook for next year?",
        "Ramesh Kumar: We expect continued double-digit growth.",
      ].join("\n");
      const chunks = chunkConcallTranscript(text, "TCS");
      assert.ok(chunks.length >= 1);
      // 6 turns / 4 per chunk = 2 chunks.
      assert.strictEqual(chunks.length, 2);
      // Prefix convention preserved (hyphen, not em-dash).
      assert.ok(chunks[0]!.text.startsWith("TCS - Earnings Call"));
      assert.ok(!chunks[0]!.text.includes("—"));
      // First chunk groups the first 4 turns.
      assert.ok(chunks[0]!.text.includes("Moderator:"));
      assert.ok(chunks[0]!.text.includes("What drove the margin expansion?"));
      // chunkIndex is sequential from 0.
      assert.strictEqual(chunks[0]!.chunkIndex, 0);
      assert.strictEqual(chunks[1]!.chunkIndex, 1);
    });

    it("captures preamble before the first speaker line", () => {
      const text = [
        "This transcript is for the Q4 FY26 earnings call of Acme Ltd.",
        "Moderator: Ladies and gentlemen, good evening.",
        "Analyst: Could you walk us through the numbers?",
      ].join("\n");
      const chunks = chunkConcallTranscript(text, "ACME");
      assert.ok(chunks.length >= 1);
      assert.ok(chunks[0]!.text.includes("This transcript is for the Q4"));
    });

    it("falls back to generic chunking when there are no speaker turns", () => {
      const text =
        "This is plain prose with no speaker turns at all, just enough length to embed.";
      const chunks = chunkConcallTranscript(text, "INFY");
      assert.ok(chunks.length >= 1);
      // Generic chunker prefixes "{SYMBOL}\n\n".
      assert.ok(chunks[0]!.text.startsWith("INFY\n\n"));
    });
  });

  describe("chunkAnnualReport (real export)", () => {
    it("ANNUAL_REPORT_HEADINGS includes the key AR sections", () => {
      assert.ok(ANNUAL_REPORT_HEADINGS.includes("MD&A"));
      assert.ok(ANNUAL_REPORT_HEADINGS.includes("Director's Report"));
      assert.ok(ANNUAL_REPORT_HEADINGS.includes("Notes to Accounts"));
      assert.ok(ANNUAL_REPORT_HEADINGS.includes("Risk"));
      assert.ok(
        ANNUAL_REPORT_HEADINGS.some((h) => h.includes("Management Discussion"))
      );
    });

    it("splits at annual-report headings, one chunk per section", () => {
      const text = [
        "Management Discussion and Analysis",
        "The company performed well across all segments this year.",
        "",
        "Director's Report",
        "The board recommends a dividend of Rs 5 per share.",
        "",
        "Notes to Accounts",
        "Note 1: Significant accounting policies are described below.",
      ].join("\n");
      const chunks = chunkAnnualReport(text, "RELIANCE");
      assert.ok(chunks.length >= 3);
      assert.ok(
        chunks.some((c) =>
          c.text.startsWith("RELIANCE - Management Discussion")
        )
      );
      assert.ok(
        chunks.some((c) => c.text.startsWith("RELIANCE - Director's Report"))
      );
      assert.ok(
        chunks.some((c) => c.text.startsWith("RELIANCE - Notes to Accounts"))
      );
      // Hyphen prefix, never em-dash.
      assert.ok(!chunks[0]!.text.includes("—"));
    });

    it("captures a cover/overview preamble before the first heading", () => {
      const text = [
        "Acme Industries Limited — Annual Report FY2026. Chairman's letter to shareholders follows here with sufficient length to be retained as overview content.",
        "Risk Management",
        "Key risks include commodity price volatility and FX exposure.",
      ].join("\n");
      const chunks = chunkAnnualReport(text, "ACME");
      assert.ok(chunks.some((c) => c.text.startsWith("ACME - Overview")));
      assert.ok(
        chunks.some((c) => c.text.startsWith("ACME - Risk Management"))
      );
    });

    it("falls back to generic chunking when no AR headings match", () => {
      const text =
        "Just some plain financial commentary with no recognisable annual report headings present.";
      const chunks = chunkAnnualReport(text, "HDFC");
      assert.ok(chunks.length >= 1);
      assert.ok(chunks[0]!.text.startsWith("HDFC\n\n"));
    });
  });

  describe("chunkByDocType dispatch (real export)", () => {
    const concall = [
      "Moderator: Welcome.",
      "Analyst: First question on revenue.",
      "CFO: Revenue was strong.",
    ].join("\n");
    const ar = [
      "Director's Report",
      "The board recommends a final dividend for the year.",
    ].join("\n");

    it("routes concall_transcript → speaker-turn chunking", () => {
      const chunks = chunkByDocType("concall_transcript", concall, "TCS");
      assert.ok(chunks[0]!.text.startsWith("TCS - Earnings Call"));
    });

    it("routes annual_report → AR-heading chunking", () => {
      const chunks = chunkByDocType("annual_report", ar, "TCS");
      assert.ok(
        chunks.some((c) => c.text.startsWith("TCS - Director's Report"))
      );
    });

    it("routes any other docType → generic chunkFinancialText", () => {
      const text =
        "Income Statement\nRevenue: 1000\nExpenses: 500\nmore data here for length\n";
      const viaDispatch = chunkByDocType("screener_financials", text, "INFY");
      const viaDirect = chunkFinancialText(text, "INFY");
      assert.deepStrictEqual(viaDispatch, viaDirect);
    });
  });

  // ── Resource bound: chunk-count cap (security) ───────────────────
  // Each chunk becomes one embedding API call, so a hostile/huge document must
  // not fan out into an unbounded chunk array.

  describe("capChunks / MAX_CHUNKS_PER_DOC (resource bound)", () => {
    it("MAX_CHUNKS_PER_DOC is a sane positive bound", () => {
      assert.ok(Number.isInteger(MAX_CHUNKS_PER_DOC));
      assert.ok(MAX_CHUNKS_PER_DOC > 0 && MAX_CHUNKS_PER_DOC <= 5000);
    });

    it("capChunks returns the SAME array (reference) when within the cap", () => {
      const chunks = [
        { text: "a", chunkIndex: 0 },
        { text: "b", chunkIndex: 1 },
      ];
      assert.strictEqual(capChunks(chunks), chunks);
    });

    it("capChunks truncates an over-cap array to MAX_CHUNKS_PER_DOC (head kept)", () => {
      const big = Array.from({ length: MAX_CHUNKS_PER_DOC + 50 }, (_, i) => ({
        text: `chunk ${i}`,
        chunkIndex: i,
      }));
      const capped = capChunks(big);
      assert.strictEqual(capped.length, MAX_CHUNKS_PER_DOC);
      assert.strictEqual(capped[0]!.chunkIndex, 0); // head retained
    });

    it("chunkAnnualReport caps a 3000-heading hostile AR at MAX_CHUNKS_PER_DOC", () => {
      const hostile = Array.from(
        { length: 3000 },
        () =>
          "Risk\nsome risk content long enough to be retained past the thirty char gate here"
      ).join("\n");
      const chunks = chunkAnnualReport(hostile, "X");
      assert.ok(chunks.length <= MAX_CHUNKS_PER_DOC);
    });

    it("chunkFinancialText caps a 3000-section hostile doc at MAX_CHUNKS_PER_DOC", () => {
      const hostile = Array.from(
        { length: 3000 },
        () =>
          "Key Ratios\nROE 10 ROCE 12 PE 20 with padding text beyond thirty chars here"
      ).join("\n");
      const chunks = chunkFinancialText(hostile, "X");
      assert.ok(chunks.length <= MAX_CHUNKS_PER_DOC);
    });

    it("chunkConcallTranscript caps a transcript with tens of thousands of turns", () => {
      // Distinct speaker per line so every line is its own turn (worst case).
      const hostile = Array.from(
        { length: 40000 },
        (_, i) => `Speaker${i}: line ${i} of the call goes here`
      ).join("\n");
      const chunks = chunkConcallTranscript(hostile, "X");
      assert.ok(chunks.length <= MAX_CHUNKS_PER_DOC);
    });

    it("does NOT cap a normal document (stays well under the bound)", () => {
      const normal =
        "Income Statement\nRevenue: 1000\nExpenses: 500\n\n" +
        "Balance Sheet\nAssets: 5000\nLiabilities: 2000\n";
      const chunks = chunkFinancialText(normal, "TCS");
      assert.ok(chunks.length < MAX_CHUNKS_PER_DOC);
      assert.ok(chunks.length >= 2);
    });
  });

  // ── Vertex RAG re-import URI builder (MONEY-804 P3c) ──────────────
  // The processor's re-import loop is gated on vertexRagConfigured() (INERT when
  // off); the only PURE bit is shaping a doc's gcsPath into a gs:// URI.

  describe("gcsUriForDocument / embedGcsBucket (MONEY-804 P3c)", () => {
    const ENV_BUCKET = "GCP_STORAGE_BUCKET";
    const saved = process.env[ENV_BUCKET];

    const restore = () => {
      if (saved === undefined) delete process.env[ENV_BUCKET];
      else process.env[ENV_BUCKET] = saved;
    };

    it("embedGcsBucket defaults to the learning-content bucket when unset", () => {
      delete process.env[ENV_BUCKET];
      try {
        assert.strictEqual(embedGcsBucket(), "stockbook-learning-content");
      } finally {
        restore();
      }
    });

    it("embedGcsBucket honours GCP_STORAGE_BUCKET", () => {
      process.env[ENV_BUCKET] = "my-bucket";
      try {
        assert.strictEqual(embedGcsBucket(), "my-bucket");
      } finally {
        restore();
      }
    });

    it("returns null for a doc with no gcsPath (text-source docs)", () => {
      assert.strictEqual(gcsUriForDocument(null), null);
      assert.strictEqual(gcsUriForDocument(undefined), null);
      assert.strictEqual(gcsUriForDocument(""), null);
      assert.strictEqual(gcsUriForDocument("   "), null);
    });

    it("builds gs://bucket/object from gcsPath", () => {
      process.env[ENV_BUCKET] = "docs-bucket";
      try {
        assert.strictEqual(
          gcsUriForDocument("stock-documents/INFY/ar-2024.pdf"),
          "gs://docs-bucket/stock-documents/INFY/ar-2024.pdf"
        );
      } finally {
        restore();
      }
    });

    it("strips a leading slash so gs://bucket//x can't form", () => {
      process.env[ENV_BUCKET] = "docs-bucket";
      try {
        assert.strictEqual(
          gcsUriForDocument("/stock-documents/x.pdf"),
          "gs://docs-bucket/stock-documents/x.pdf"
        );
      } finally {
        restore();
      }
    });
  });
});
