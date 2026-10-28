/**
 * Stock Document Extraction Processor Tests (MONEY-783)
 * (workers/src/processors/stock-document-extract.ts) — PURE helpers only.
 *
 * The query/path builders + the re-exported text cap live in
 * `workers/src/processors/stock-document-extract-logic.ts`, which the I/O
 * processor imports and CALLS; this test asserts the REAL exports (no shadow).
 * The I/O seam (`stock-document-extract.ts`) + the route are never-throw /
 * ACK-200-on-throw and untested at this layer, same posture as the embed
 * processor and login-briefing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// REAL worker source under test (no shadow).
import {
  MAX_TEXT_LENGTH,
  capTextContent,
  buildExtractQuery,
  buildGcsUri,
  assertSafeObjectKey,
  extractedSidecarPath,
  shouldFetchFromSource,
  isFetchableSourceUrl,
  // MONEY-1255 — mime normalization + the queue-drain controls.
  CANONICAL_PDF_MIME_TYPE,
  EXTRACTABLE_DOC_MIME_TYPES,
  normalizeDocMimeType,
  isExtractableDocMimeType,
  initialProcessingStatus,
  EXTRACT_ORDER_BY,
  DEFAULT_EXTRACT_BATCH_SIZE,
  RUN_TIME_BUDGET_MS,
  MAX_CHAIN_DEPTH,
  isWithinRunBudget,
  normalizeChainDepth,
  shouldChainAnotherBatch,
  // MONEY-1329 — the stale-PROCESSING reclaim arm.
  STALE_PROCESSING_MS,
  // MONEY-1347 — sidecar-first RAG text.
  decideTextSource,
} from "../../../../workers/src/processors/stock-document-extract-logic";
// The threshold `decideTextSource` DEFERS to. Imported by its own subpath so a
// change there fails these assertions instead of drifting past a local copy.
import { SCANNED_SHARE_VISION_THRESHOLD } from "@usemoney/core/market-data/doc-convert-logic";
// The SAME rule the two write sites use, reached by its own subpath — so a
// change there fails these assertions rather than drifting past them.
import { normalizeDocMimeType as normalizeFromCore } from "@usemoney/core/market-data/doc-mime";
// The status union the app renders. `UNSUPPORTED` has to survive the round
// trip or the repair writes a value the UI shows as "Unknown state".
import {
  normalizeProcessingStatus,
  isReadableDocument,
} from "@usemoney/core/market-data";

/**
 * The run clock every `buildExtractQuery` case in this file pins, so the
 * stale-PROCESSING cutoff is a fixed date rather than whatever the suite ran at.
 */
const NOW = new Date("2026-09-05T12:00:00.000Z");

/** Shape of the OR arms MONEY-1329 introduced. */
interface StatusArm {
  processingStatus: unknown;
  updatedAt?: { lt: Date };
}

/**
 * Read the status OR arms off a built query.
 *
 * Deliberately ASSERTS the shape rather than casting into it: if the builder
 * ever stops producing an OR, every case below must fail loudly instead of
 * reading `undefined` and passing a `deepStrictEqual` against nothing.
 */
function statusArms(where: Record<string, unknown>): StatusArm[] {
  const or = where.OR;
  assert.ok(
    Array.isArray(or) && or.length > 0,
    "the extract query no longer selects on an OR of statuses — if that is " +
      "deliberate, the stale-PROCESSING reclaim arm (MONEY-1329) is gone"
  );
  return or as StatusArm[];
}

describe("Workers - Processor: Stock Document Extract", () => {
  // ── Re-exported text cap (single source of truth) ────────────────

  describe("MAX_TEXT_LENGTH / capTextContent (re-exported from document-process-logic)", () => {
    it("MAX_TEXT_LENGTH is 100_000", () => {
      assert.strictEqual(MAX_TEXT_LENGTH, 100_000);
    });

    it("capTextContent returns text unchanged when under the cap", () => {
      const text = "short text";
      assert.strictEqual(capTextContent(text), text);
    });

    it("capTextContent truncates text over the cap to MAX_TEXT_LENGTH", () => {
      const text = "X".repeat(MAX_TEXT_LENGTH + 500);
      const capped = capTextContent(text);
      assert.strictEqual(capped.length, MAX_TEXT_LENGTH);
    });
  });

  // ── buildExtractQuery (real export) ──────────────────────────────

  describe("buildExtractQuery (real export)", () => {
    it("defaults to PENDING-only, and to the readable containers", () => {
      // MONEY-1319 — this used to read "PDF-only" and assert
      // `{ in: ["application/pdf"] }`, which was the correct contract for as
      // long as no extractor in this repo could open an archive. The lane now
      // opens a ZIP and selects the member (`resolveExtractionSource`), so
      // `application/zip` joined `EXTRACTABLE_DOC_MIME_TYPES` in the SAME
      // change. The invariant that survives is "exactly the types the lane can
      // read, and nothing else" — asserted here against the shared array and,
      // in the negative case below, against the types it still cannot.
      const where = buildExtractQuery({ now: NOW });
      // MONEY-1329 moved the status test into an OR (the stale-PROCESSING
      // reclaim arm sits beside it), so `processingStatus` is no longer a
      // top-level key. The FIRST arm is the one this case is about.
      assert.ok(!("processingStatus" in where));
      assert.strictEqual(statusArms(where)[0].processingStatus, "PENDING");
      assert.deepStrictEqual(where.mimeType, {
        in: [...EXTRACTABLE_DOC_MIME_TYPES],
      });
      assert.deepStrictEqual(
        [...EXTRACTABLE_DOC_MIME_TYPES].sort(),
        ["application/pdf", "application/zip"],
        "adding a type here without teaching the lane to read it puts rows " +
          "back into the select-and-fail loop MONEY-1319 measured"
      );
      assert.ok(!("symbol" in where));
      assert.ok(!("docType" in where));
    });

    it("force:true widens to PENDING + FAILED", () => {
      const where = buildExtractQuery({ force: true, now: NOW });
      assert.deepStrictEqual(statusArms(where)[0].processingStatus, {
        in: ["PENDING", "FAILED"],
      });
    });

    it("upper-cases symbol filter", () => {
      const where = buildExtractQuery({ symbols: ["tcs", "Infy"], now: NOW });
      assert.deepStrictEqual(where.symbol, { in: ["TCS", "INFY"] });
    });

    it("omits symbol filter when symbols is empty", () => {
      const where = buildExtractQuery({ symbols: [], now: NOW });
      assert.ok(!("symbol" in where));
    });

    it("applies docType filter verbatim", () => {
      const where = buildExtractQuery({
        docTypes: ["annual_report", "quarterly_result"],
        now: NOW,
      });
      assert.deepStrictEqual(where.docType, {
        in: ["annual_report", "quarterly_result"],
      });
    });

    it("omits docType filter when docTypes is empty", () => {
      const where = buildExtractQuery({ docTypes: [], now: NOW });
      assert.ok(!("docType" in where));
    });

    it("always restricts to the readable containers, whatever else is set", () => {
      const where = buildExtractQuery({
        symbols: ["tcs"],
        docTypes: ["annual_report"],
        force: true,
        now: NOW,
      });
      assert.deepStrictEqual(where.mimeType, {
        in: [...EXTRACTABLE_DOC_MIME_TYPES],
      });
      assert.deepStrictEqual(statusArms(where)[0].processingStatus, {
        in: ["PENDING", "FAILED"],
      });
      assert.deepStrictEqual(where.symbol, { in: ["TCS"] });
      assert.deepStrictEqual(where.docType, { in: ["annual_report"] });
    });
  });

  // ── buildGcsUri (real export) ────────────────────────────────────

  describe("buildGcsUri (real export)", () => {
    const original = process.env.GCP_STORAGE_BUCKET;

    beforeEach(() => {
      process.env.GCP_STORAGE_BUCKET = "stockbook-content-test";
    });

    afterEach(() => {
      if (original === undefined) delete process.env.GCP_STORAGE_BUCKET;
      else process.env.GCP_STORAGE_BUCKET = original;
    });

    it("builds a gs:// URI from the bucket + path", () => {
      assert.strictEqual(
        buildGcsUri("stocks/TCS/annual_report/2024.pdf"),
        "gs://stockbook-content-test/stocks/TCS/annual_report/2024.pdf"
      );
    });

    it("throws when GCP_STORAGE_BUCKET is unset", () => {
      delete process.env.GCP_STORAGE_BUCKET;
      assert.throws(
        () => buildGcsUri("stocks/TCS/annual_report/2024.pdf"),
        /GCP_STORAGE_BUCKET/
      );
    });

    // ── SSRF / object-confusion hardening ──────────────────────────
    it("always pins the bucket — a path cannot repoint to another bucket", () => {
      // Even a path that LOOKS like a bucket-relative escape stays a suffix.
      const uri = buildGcsUri("stocks/TCS/ar/2024.pdf");
      assert.ok(uri.startsWith("gs://stockbook-content-test/"));
    });

    it("rejects a path that carries its own gs:// scheme (bucket hijack)", () => {
      assert.throws(
        () => buildGcsUri("gs://attacker-bucket/secret.pdf"),
        /relative object key/
      );
    });

    it("rejects a path that carries an https:// scheme", () => {
      assert.throws(
        () => buildGcsUri("https://evil.example/x.pdf"),
        /relative object key/
      );
    });

    it("rejects an absolute path", () => {
      assert.throws(() => buildGcsUri("/etc/passwd"), /must not be absolute/);
    });

    it("rejects a '..' traversal segment", () => {
      assert.throws(
        () => buildGcsUri("stocks/../../other/secret.pdf"),
        /'\.\.' segments/
      );
    });

    it("rejects a path with an embedded newline (CRLF smuggling)", () => {
      assert.throws(
        () => buildGcsUri("stocks/TCS/ar/2024.pdf\nname: other"),
        /control characters/
      );
    });

    it("rejects an empty path", () => {
      assert.throws(() => buildGcsUri("   "), /empty/);
    });
  });

  // ── assertSafeObjectKey (real export) ────────────────────────────

  describe("assertSafeObjectKey (real export)", () => {
    it("accepts the legitimate buildFullDocPath shape", () => {
      assert.doesNotThrow(() =>
        assertSafeObjectKey(
          "stocks/M&M/annual_report/M&M-annual_report-FY2024.pdf"
        )
      );
      assert.doesNotThrow(() =>
        assertSafeObjectKey("stocks/TCS/quarterly_result/TCS-q1-2025.pdf")
      );
    });

    it("accepts the derived .extracted.txt sidecar key", () => {
      assert.doesNotThrow(() =>
        assertSafeObjectKey(
          extractedSidecarPath("stocks/TCS/annual_report/2024.pdf")
        )
      );
    });

    it("rejects scheme / absolute / traversal / control-char keys", () => {
      assert.throws(
        () => assertSafeObjectKey("gs://b/x"),
        /relative object key/
      );
      assert.throws(
        () => assertSafeObjectKey("file:///etc/passwd"),
        /relative object key/
      );
      assert.throws(
        () => assertSafeObjectKey("/abs/path"),
        /must not be absolute/
      );
      assert.throws(() => assertSafeObjectKey("a/../b"), /'\.\.' segments/);
      assert.throws(() => assertSafeObjectKey("a\tb"), /control characters/);
      assert.throws(() => assertSafeObjectKey(""), /empty/);
    });
  });

  // ── extractedSidecarPath (real export) ───────────────────────────

  describe("extractedSidecarPath (real export)", () => {
    it("appends .extracted.txt to the source path", () => {
      assert.strictEqual(
        extractedSidecarPath("stocks/TCS/annual_report/2024.pdf"),
        "stocks/TCS/annual_report/2024.pdf.extracted.txt"
      );
    });

    it("is deterministic from the source path (no schema column)", () => {
      const path = "stocks/RELIANCE/quarterly_result/q1-2025.pdf";
      assert.strictEqual(
        extractedSidecarPath(path),
        extractedSidecarPath(path)
      );
    });
  });

  // ── isFetchableSourceUrl (real export) ───────────────────────────
  // MONEY-798 P3c: a discovered (rag-enqueue) doc has a PLACEHOLDER gcsPath and a
  // real sourceUrl; only a non-empty absolute http(s) URL is fetchable.

  describe("isFetchableSourceUrl (real export)", () => {
    it("accepts absolute http(s) URLs", () => {
      assert.strictEqual(
        isFetchableSourceUrl("https://nsearchives.nseindia.com/x.pdf"),
        true
      );
      assert.strictEqual(isFetchableSourceUrl("http://example.com/a"), true);
    });

    it("rejects empty / whitespace / nullish values", () => {
      assert.strictEqual(isFetchableSourceUrl(""), false);
      assert.strictEqual(isFetchableSourceUrl("   "), false);
      assert.strictEqual(isFetchableSourceUrl(null), false);
      assert.strictEqual(isFetchableSourceUrl(undefined), false);
    });

    it("rejects non-http(s) / relative values (placeholder paths, schemes)", () => {
      assert.strictEqual(isFetchableSourceUrl("stocks/TCS/ar/latest"), false);
      assert.strictEqual(isFetchableSourceUrl("ftp://host/f"), false);
      assert.strictEqual(isFetchableSourceUrl("gs://bucket/x.pdf"), false);
    });
  });

  // ── shouldFetchFromSource (real export) ──────────────────────────
  // The "has sourceUrl, no gcs object" decision: fetch from sourceUrl only when
  // the GCS object is MISSING and the sourceUrl is fetchable. A present object
  // always wins (use the stored bytes); a missing object with no fetchable
  // sourceUrl is a genuine failure (NOT a fetch case).

  describe("shouldFetchFromSource (real export)", () => {
    it("fetches when object is missing and sourceUrl is fetchable (discovery row)", () => {
      assert.strictEqual(
        shouldFetchFromSource(false, "https://nse/x.pdf"),
        true
      );
    });

    it("does NOT fetch when the GCS object is already present", () => {
      assert.strictEqual(
        shouldFetchFromSource(true, "https://nse/x.pdf"),
        false
      );
    });

    it("does NOT fetch when object is missing and sourceUrl is not fetchable (genuine failure)", () => {
      assert.strictEqual(shouldFetchFromSource(false, ""), false);
      assert.strictEqual(shouldFetchFromSource(false, null), false);
      assert.strictEqual(shouldFetchFromSource(false, undefined), false);
      assert.strictEqual(
        shouldFetchFromSource(false, "stocks/TCS/ar/latest"),
        false
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // MONEY-1255 — the 1,211 rows that could never be selected
  // ══════════════════════════════════════════════════════════════════

  describe("normalizeDocMimeType (real export)", () => {
    it("is the SAME function the write sites import from @usemoney/core", () => {
      // Not a style point. The bug was a rule stated twice — a substring test
      // naming the file, an exact match selecting the row — so an assertion
      // against a re-export that is not the real symbol would prove nothing.
      assert.strictEqual(normalizeDocMimeType, normalizeFromCore);
    });

    it("collapses the prod spelling that made 1 PDF unreachable", () => {
      assert.strictEqual(
        normalizeDocMimeType("application/pdf;charset=UTF-8"),
        "application/pdf"
      );
    });

    it("drops parameters from a non-PDF type instead of keeping four spellings", () => {
      // All four HTML spellings measured on prod collapse to one value.
      for (const raw of [
        "text/html; charset=UTF-8",
        "text/html; charset=utf-8",
        "text/html;charset=UTF-8",
        "text/html;charset=utf-8",
        "text/html",
        "  TEXT/HTML  ",
      ]) {
        assert.strictEqual(normalizeDocMimeType(raw), "text/html", raw);
      }
    });

    it("keeps a type it does not recognise, rather than guessing PDF", () => {
      assert.strictEqual(normalizeDocMimeType("audio/mpeg"), "audio/mpeg");
      assert.strictEqual(
        normalizeDocMimeType("application/zip"),
        "application/zip"
      );
    });

    it("treats an absent header as the schema default", () => {
      // The call sites already applied `|| "application/pdf"`; a row that
      // predates the column arrives here as null and must not become "".
      assert.strictEqual(normalizeDocMimeType(null), "application/pdf");
      assert.strictEqual(normalizeDocMimeType(undefined), "application/pdf");
      assert.strictEqual(normalizeDocMimeType(""), "application/pdf");
      assert.strictEqual(normalizeDocMimeType("   "), "application/pdf");
    });

    it("recognises the other real-world PDF spellings", () => {
      for (const raw of ["application/x-pdf", "APPLICATION/PDF", "text/pdf"]) {
        assert.strictEqual(normalizeDocMimeType(raw), "application/pdf", raw);
      }
    });
  });

  describe("the write value and the extract query agree (the actual defect)", () => {
    it("EVERY normalized PDF spelling satisfies buildExtractQuery", () => {
      // This is the assertion that would have failed before the fix. The stored
      // value and the query's `in` list were two independent statements of one
      // rule, and they disagreed for exactly one spelling.
      const where = buildExtractQuery({ now: NOW }) as {
        mimeType: { in: string[] };
      };
      for (const raw of [
        "application/pdf",
        "application/pdf;charset=UTF-8",
        "application/pdf; charset=utf-8",
        "APPLICATION/PDF",
        "application/x-pdf",
        null,
      ]) {
        assert.ok(
          where.mimeType.in.includes(normalizeDocMimeType(raw)),
          `a PDF stored as ${JSON.stringify(raw)} must be selectable`
        );
      }
    });

    it("the query reads EXTRACTABLE_DOC_MIME_TYPES, not a literal", () => {
      const where = buildExtractQuery({ now: NOW }) as {
        mimeType: { in: string[] };
      };
      assert.deepStrictEqual(where.mimeType.in, [
        ...EXTRACTABLE_DOC_MIME_TYPES,
      ]);
      assert.ok(EXTRACTABLE_DOC_MIME_TYPES.includes(CANONICAL_PDF_MIME_TYPE));
    });

    it("a type the lane CANNOT read is still not selectable", () => {
      // MONEY-1319 moved `application/zip` OUT of this list, because the lane
      // learned to open one. It is deliberately still asserted the other way
      // round in the case above — the two together say "exactly these two, and
      // nothing else", which is what a bare positive assertion could not.
      const where = buildExtractQuery({ now: NOW }) as {
        mimeType: { in: string[] };
      };
      for (const raw of [
        "text/html; charset=UTF-8",
        "audio/mpeg",
        "application/octet-stream",
        "application/vnd.ms-excel",
      ]) {
        assert.ok(
          !where.mimeType.in.includes(normalizeDocMimeType(raw)),
          `${raw} must stay out of the extract queue`
        );
      }
    });
  });

  describe("initialProcessingStatus / isExtractableDocMimeType (real exports)", () => {
    it("a PDF, however spelled, is queued", () => {
      for (const raw of [
        "application/pdf",
        "application/pdf;charset=UTF-8",
        null,
      ]) {
        assert.strictEqual(isExtractableDocMimeType(raw), true, String(raw));
        assert.strictEqual(
          initialProcessingStatus(raw),
          "PENDING",
          String(raw)
        );
      }
    });

    it("the types NO extractor can read are terminal, not queued", () => {
      // 1,210 rows. PENDING was a claim about a future that could not arrive.
      //
      // MONEY-1319 — `application/zip` used to be in this list and is now in
      // the case below instead. It was correct here for as long as its own
      // premise held ("no extractor in this repo will ever read one"); the
      // extract lane now opens the archive and selects the member, so leaving
      // it terminal would strand 179 real NSE documents in `UNSUPPORTED`.
      for (const raw of [
        "text/html; charset=UTF-8",
        "text/html",
        "audio/mpeg",
        "application/octet-stream",
      ]) {
        assert.strictEqual(isExtractableDocMimeType(raw), false, raw);
        assert.strictEqual(initialProcessingStatus(raw), "UNSUPPORTED", raw);
      }
    });

    it("a ZIP is queued now, because the lane can open one", () => {
      assert.strictEqual(isExtractableDocMimeType("application/zip"), true);
      assert.strictEqual(initialProcessingStatus("application/zip"), "PENDING");
    });

    it("UNSUPPORTED round-trips through the app's status normalizer", () => {
      // A repair that writes a value the UI renders as "Unknown state" has
      // traded one invisible pile for another.
      assert.strictEqual(
        normalizeProcessingStatus(initialProcessingStatus("text/html")),
        "UNSUPPORTED"
      );
      assert.strictEqual(
        normalizeProcessingStatus(initialProcessingStatus("application/pdf")),
        "PENDING"
      );
      assert.strictEqual(
        normalizeProcessingStatus("unsupported"),
        "UNSUPPORTED"
      );
    });

    it("UNSUPPORTED is NOT readable — it has no textContent by definition", () => {
      assert.strictEqual(isReadableDocument("UNSUPPORTED"), false);
    });
  });

  // ── the queue drained LIFO at 50/day ─────────────────────────────

  describe("EXTRACT_ORDER_BY (real export)", () => {
    it("is OLDEST FIRST", () => {
      assert.deepStrictEqual(EXTRACT_ORDER_BY, { fetchedAt: "asc" });
    });

    it("is explicitly NOT desc — the whole defect", () => {
      // Newest-first over a queue that grows by thousands a week pushes the
      // oldest rows down on every cycle and never reaches them (MONEY-1211).
      assert.notStrictEqual(
        (EXTRACT_ORDER_BY as { fetchedAt: string }).fetchedAt,
        "desc"
      );
    });
  });

  describe("the run budget fits inside the 600s Pub/Sub ack deadline", () => {
    const ACK_DEADLINE_MS = 600_000;

    it("leaves real headroom, not a rounding error", () => {
      assert.ok(
        RUN_TIME_BUDGET_MS < ACK_DEADLINE_MS,
        "a budget at or past the ack deadline redelivers the message and runs a SECOND copy"
      );
      // The check is BETWEEN documents, so the true wall is budget + one
      // document. One pathological document is a ~30-page cross-region Document
      // AI call plus a pdf-parse fallback plus a sidecar upload — tens of
      // seconds. 120s is the floor that keeps that survivable.
      assert.ok(
        ACK_DEADLINE_MS - RUN_TIME_BUDGET_MS >= 120_000,
        `headroom is ${ACK_DEADLINE_MS - RUN_TIME_BUDGET_MS}ms; the loop can overshoot by one document`
      );
    });

    it("isWithinRunBudget opens the gate before and closes it after", () => {
      const t0 = 1_000_000;
      assert.strictEqual(isWithinRunBudget(t0, t0), true);
      assert.strictEqual(
        isWithinRunBudget(t0, t0 + RUN_TIME_BUDGET_MS - 1),
        true
      );
      assert.strictEqual(isWithinRunBudget(t0, t0 + RUN_TIME_BUDGET_MS), false);
      assert.strictEqual(
        isWithinRunBudget(t0, t0 + RUN_TIME_BUDGET_MS + 1),
        false
      );
    });

    it("the default batch is a page size, not the throughput control", () => {
      // Even at an optimistic 1s/document the default page cannot finish inside
      // the budget, which is the proof that the CLOCK binds and the count does
      // not. Raising a count is the lever MONEY-1201 rejected.
      assert.ok(DEFAULT_EXTRACT_BATCH_SIZE * 1000 > RUN_TIME_BUDGET_MS);
      assert.ok(DEFAULT_EXTRACT_BATCH_SIZE > 50, "50/day was the starvation");
    });
  });

  describe("normalizeChainDepth (real export)", () => {
    it("absent / garbage reads as depth 0", () => {
      for (const v of [
        undefined,
        null,
        "3",
        NaN,
        Infinity,
        -Infinity,
        {},
        [],
      ]) {
        assert.strictEqual(
          normalizeChainDepth(v),
          0,
          JSON.stringify(v ?? null)
        );
      }
    });

    it("a negative depth cannot buy extra links", () => {
      assert.strictEqual(normalizeChainDepth(-1), 0);
      assert.strictEqual(normalizeChainDepth(-1e9), 0);
    });

    it("an oversized depth is clamped TO the ceiling, so it ENDS the chain", () => {
      assert.strictEqual(normalizeChainDepth(1e9), MAX_CHAIN_DEPTH);
      assert.strictEqual(
        shouldChainAnotherBatch({
          selected: 500,
          batchSize: 500,
          chainDepth: normalizeChainDepth(1e9),
          leftPending: 500,
          force: false,
        }),
        false
      );
    });

    it("floors a fractional depth", () => {
      assert.strictEqual(normalizeChainDepth(3.9), 3);
    });
  });

  describe("shouldChainAnotherBatch (real export)", () => {
    const healthy = {
      selected: 500,
      batchSize: 500,
      chainDepth: 0,
      leftPending: 500,
      force: false,
    };

    it("chains when the page was full and rows moved", () => {
      assert.strictEqual(shouldChainAnotherBatch(healthy), true);
    });

    it("stops when the queue ran dry (short page)", () => {
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, selected: 499 }),
        false
      );
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, selected: 0, leftPending: 0 }),
        false
      );
    });

    it("stops when NOT ONE row left PENDING — the runaway shape", () => {
      // Every update threw, so the next query would return the identical page.
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, leftPending: 0 }),
        false
      );
    });

    it("never chains a forced run", () => {
      // force widens the selection to PENDING+FAILED, so a deterministically
      // failing document is selected again on every link — no fixpoint.
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, force: true }),
        false
      );
      assert.strictEqual(
        shouldChainAnotherBatch({
          ...healthy,
          force: true,
          chainDepth: MAX_CHAIN_DEPTH - 5,
        }),
        false
      );
    });

    it("refuses a zero/negative batch instead of dividing by the page", () => {
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, batchSize: 0, selected: 0 }),
        false
      );
      assert.strictEqual(
        shouldChainAnotherBatch({ ...healthy, batchSize: -1 }),
        false
      );
    });

    it("refuses the link that would REACH the ceiling", () => {
      assert.strictEqual(
        shouldChainAnotherBatch({
          ...healthy,
          chainDepth: MAX_CHAIN_DEPTH - 2,
        }),
        true
      );
      assert.strictEqual(
        shouldChainAnotherBatch({
          ...healthy,
          chainDepth: MAX_CHAIN_DEPTH - 1,
        }),
        false
      );
    });

    it("[TERMINATION] the chain ends against an adversary that always has more work", () => {
      // The proof, driven rather than argued. The environment reports a FULL
      // page and full progress on every link — the one input pattern under
      // which every stop condition except the depth ceiling stays open. If the
      // ceiling were removed, dropped, or compared with `>` instead of `>=`,
      // this loop would not return.
      let depth = 0;
      let links = 0;
      const HARD_STOP = MAX_CHAIN_DEPTH * 10 + 100;
      while (
        shouldChainAnotherBatch({
          selected: 500,
          batchSize: 500,
          chainDepth: depth,
          leftPending: 500,
          force: false,
        })
      ) {
        depth = normalizeChainDepth(depth + 1);
        links++;
        assert.ok(
          links < HARD_STOP,
          "shouldChainAnotherBatch never refused — the chain does not terminate"
        );
      }
      assert.strictEqual(
        links,
        MAX_CHAIN_DEPTH - 1,
        "a chain must be bounded by MAX_CHAIN_DEPTH messages"
      );
      assert.ok(depth < MAX_CHAIN_DEPTH);
    });

    it("[TERMINATION] the bound does not depend on progress or page fullness", () => {
      // Same loop, but the environment lies in the *other* direction on every
      // link. Both halves must terminate; only one of them relies on the depth.
      for (const env of [
        { selected: 1, batchSize: 500, leftPending: 1 },
        { selected: 500, batchSize: 500, leftPending: 0 },
      ]) {
        let depth = 0;
        let links = 0;
        while (
          shouldChainAnotherBatch({ ...env, chainDepth: depth, force: false })
        ) {
          depth++;
          links++;
          assert.ok(links < 1000, "did not terminate");
        }
        assert.strictEqual(
          links,
          0,
          "these environments must not chain at all"
        );
      }
    });

    it("MAX_CHAIN_DEPTH keeps one trigger inside its nightly window", () => {
      // 20 links x 420s ≈ 2h20m from the 22:00 IST trigger. A ceiling that let
      // the chain run past the next day's jobs would be a different problem.
      assert.ok(MAX_CHAIN_DEPTH >= 2, "a ceiling of 1 is not a chain");
      assert.ok(
        MAX_CHAIN_DEPTH * RUN_TIME_BUDGET_MS <= 3 * 60 * 60 * 1000,
        "the chain must finish inside a ~3h window"
      );
    });
  });
  // ── MONEY-1329: the stale-PROCESSING reclaim arm ─────────────────

  describe("buildExtractQuery: stuck PROCESSING rows (MONEY-1329)", () => {
    // Measured on prod: 29 rows sit `processingStatus: "PROCESSING"` in this
    // lane and, before this change, NO query in the repo selected them. The
    // loop flips a row to PROCESSING before it does any work — that flip is a
    // CLAIM — and every terminal path releases it. What does not release it is
    // the run ENDING between the two: an instance recycled mid-document, an OOM
    // kill. That is a permanent leak, not a delay, and it is silent because
    // every counter reads healthy: the row WAS selected, it just never came
    // back.

    it("STALE_PROCESSING_MS is 6h — far past any honest run", () => {
      assert.strictEqual(STALE_PROCESSING_MS, 6 * 60 * 60 * 1000);
      // The one thing that can legitimately hold a claim open is a single run
      // of this job, whose wall is RUN_TIME_BUDGET_MS inside a 600s ack
      // deadline. Six hours is ~36x that ceiling and clears the whole 20-link
      // chain, so the cutoff can never fire on a live instance.
      assert.ok(
        STALE_PROCESSING_MS > MAX_CHAIN_DEPTH * RUN_TIME_BUDGET_MS,
        "a cutoff inside the chain's own runtime would let two runs extract " +
          "the same document concurrently"
      );
    });

    it("carries a PROCESSING arm cut at exactly now - STALE_PROCESSING_MS", () => {
      const arms = statusArms(buildExtractQuery({ now: NOW }));
      const stale = arms.find((a) => a.processingStatus === "PROCESSING");
      assert.ok(stale, "the reclaim arm is missing — 29 rows stay unreachable");
      assert.ok(
        stale.updatedAt,
        "an unbounded PROCESSING arm would re-select " +
          "a document a LIVE instance is working on right now"
      );
      assert.strictEqual(
        stale.updatedAt.lt.getTime(),
        NOW.getTime() - STALE_PROCESSING_MS
      );
    });

    it("a row 1 hour old is NOT selected; 7 hours old IS", () => {
      const arms = statusArms(buildExtractQuery({ now: NOW }));
      const stale = arms.find((a) => a.processingStatus === "PROCESSING");
      assert.ok(stale?.updatedAt);
      const cutoff = stale.updatedAt.lt.getTime();

      const oneHourOld = NOW.getTime() - 1 * 60 * 60 * 1000;
      const sevenHoursOld = NOW.getTime() - 7 * 60 * 60 * 1000;

      // `lt` is the Prisma predicate, so this is the selection itself, not a
      // restatement of it.
      assert.ok(
        !(oneHourOld < cutoff),
        "a claim taken an hour ago may still be live — stealing it would " +
          "spend a second Document AI call on the same document"
      );
      assert.ok(
        sevenHoursOld < cutoff,
        "a claim older than the cutoff must be reclaimable, or the leak is " +
          "permanent"
      );
    });

    it("the reclaim arm survives force, symbols and docType filters", () => {
      // The leak is orthogonal to every other filter, so a run scoped to one
      // symbol must still reclaim that symbol's stuck rows.
      for (const opts of [
        { now: NOW },
        { now: NOW, force: true },
        { now: NOW, symbols: ["tcs"] },
        { now: NOW, docTypes: ["annual_report"] },
      ]) {
        const arms = statusArms(buildExtractQuery(opts));
        assert.ok(
          arms.some((a) => a.processingStatus === "PROCESSING"),
          `the reclaim arm vanished for ${JSON.stringify(opts)}`
        );
      }
    });

    it("the PENDING/FAILED arm and the PROCESSING arm are separate", () => {
      // They must not be merged into one `in: [...]`: a bare
      // `{in:["PENDING","PROCESSING"]}` would take EVERY in-flight row,
      // including one a live instance claimed a second ago.
      const arms = statusArms(buildExtractQuery({ now: NOW, force: true }));
      assert.strictEqual(arms.length, 2);
      const stale = arms.find((a) => a.processingStatus === "PROCESSING");
      const normal = arms.find((a) => a.processingStatus !== "PROCESSING");
      assert.ok(stale?.updatedAt, "the PROCESSING arm must be time-bounded");
      assert.ok(
        normal && !normal.updatedAt,
        "the PENDING/FAILED arm must NOT be time-bounded — that would stop " +
          "the job taking freshly-synced documents"
      );
    });

    it("the mimeType restriction still ANDs with the OR", () => {
      // A top-level OR beside a scalar filter is an AND in Prisma. If the
      // mimeType arm had been folded INTO the OR, the lane would select
      // audio/mpeg rows the moment they went stale.
      const where = buildExtractQuery({ now: NOW });
      assert.deepStrictEqual(where.mimeType, {
        in: [...EXTRACTABLE_DOC_MIME_TYPES],
      });
    });
  });

  // ── MONEY-1347: sidecar-first RAG text ───────────────────────────

  describe("decideTextSource (real export)", () => {
    // Measured on prod: 34,915 rows PENDING in this lane while 32,893
    // documents ALREADY hold a converted markdown sidecar at
    // `markdownGcsPath` that nothing reads for text. Reading it costs one GCS
    // read and zero Document AI calls.
    const CONVERTED = {
      convertStatus: "CONVERTED",
      markdownGcsPath: "stocks/TCS/annual_report/x.pdf.md",
      textPageCount: 100,
      scannedPageCount: 0,
    };

    it("a COMPLETE sidecar is read instead of the extractor", () => {
      assert.strictEqual(decideTextSource(CONVERTED), "sidecar");
    });

    it("a sidecar with a few scanned pages is still complete enough", () => {
      // 10 scanned of 110 = 9.1%, under the 20% threshold.
      assert.strictEqual(
        decideTextSource({ ...CONVERTED, scannedPageCount: 10 }),
        "sidecar"
      );
    });

    it("an INCOMPLETE sidecar (40 scanned / 60 text) goes to the extractor", () => {
      // 40% scanned. The sidecar is MISSING PAGES and nothing about the
      // resulting text says so — BONLON FY2025 lost pages 92-135, exactly the
      // statement block, and read as a clean shorter document. Half a document
      // silently becoming the whole document is not detectable downstream.
      assert.strictEqual(
        decideTextSource({
          ...CONVERTED,
          scannedPageCount: 40,
          textPageCount: 60,
        }),
        "extractor"
      );
    });

    it("the incompleteness cut is the SHARED threshold, not a local copy", () => {
      // Straddle SCANNED_SHARE_VISION_THRESHOLD with a 1,000-page document so
      // the boundary is exact rather than approximated by rounding. `>=` is
      // the shared rule, so exactly-at-threshold is INCOMPLETE.
      const total = 1000;
      const atCut = Math.round(SCANNED_SHARE_VISION_THRESHOLD * total);
      assert.strictEqual(
        decideTextSource({
          ...CONVERTED,
          scannedPageCount: atCut,
          textPageCount: total - atCut,
        }),
        "extractor"
      );
      assert.strictEqual(
        decideTextSource({
          ...CONVERTED,
          scannedPageCount: atCut - 1,
          textPageCount: total - atCut + 1,
        }),
        "sidecar"
      );
    });

    it("no sidecar path → extractor", () => {
      for (const markdownGcsPath of [null, undefined, "", "   "]) {
        assert.strictEqual(
          decideTextSource({ ...CONVERTED, markdownGcsPath }),
          "extractor",
          `markdownGcsPath ${JSON.stringify(markdownGcsPath)} must not be read`
        );
      }
    });

    it("CONVERTED but textPageCount 0 → extractor", () => {
      // A conversion that produced zero text pages produced no text.
      assert.strictEqual(
        decideTextSource({ ...CONVERTED, textPageCount: 0 }),
        "extractor"
      );
    });

    it("an UNMEASURED document (null counters) → extractor", () => {
      // `sidecarIsPageIncomplete` returns `incomplete: false` for null
      // counters — an absent measurement is not evidence of incompleteness —
      // so the textPageCount test is what stops the whole pre-MONEY-1314
      // corpus reaching the sidecar path on the strength of a shrug.
      assert.strictEqual(
        decideTextSource({
          ...CONVERTED,
          textPageCount: null,
          scannedPageCount: null,
        }),
        "extractor"
      );
    });

    it("only CONVERTED qualifies — every other convertStatus goes to the extractor", () => {
      for (const convertStatus of [
        "PENDING",
        "SCANNED_ONLY",
        "FAILED",
        null,
        undefined,
        "converted",
      ]) {
        assert.strictEqual(
          decideTextSource({ ...CONVERTED, convertStatus }),
          "extractor",
          `convertStatus ${JSON.stringify(convertStatus)} has no readable sidecar`
        );
      }
    });
  });
});
