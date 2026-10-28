/**
 * Stock Document Sync Processor Tests (workers/src/processors/stock-document-sync.ts)
 *
 * De-shadowed: imports the REAL pure exports from
 * `workers/src/processors/stock-document-sync-logic.ts`, which the processor
 * itself calls. The former inline copies of every constant + helper
 * (extractPeriod, cleanSymbol, isValidEquitySymbol, isWithinApiLimit,
 * normalizeScreenerDocType, inferExtension, buildNseUrl) were a shadow.
 *
 * Covers:
 *   - constants (DELAY_BETWEEN_SYMBOLS_MS, API_LIMITS, NSE_BASE)
 *   - extractPeriod (Q / FY / date fallback + INVALID-DATE guard)
 *   - cleanSymbol, isValidEquitySymbol (excluded symbols/patterns)
 *   - isWithinApiLimit, normalizeScreenerDocType, inferExtension, buildNseUrl
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DELAY_BETWEEN_SYMBOLS_MS,
  NSE_BASE,
  API_LIMITS,
  MAX_SYMBOLS_PER_RUN,
  extractPeriod,
  cleanSymbol,
  isValidEquitySymbol,
  isWithinApiLimit,
  normalizeScreenerDocType,
  inferExtension,
  buildNseUrl,
  buildTickertapeUrl,
  buildScreenerUrl,
  boundSymbolBatch,
  // MONEY-1255 — rotation, throughput, leg accounting.
  buildDocumentSyncOrderBy,
  buildDocumentSyncWhere,
  isTickertapeOnlyRun,
  resolveSymbolPageSize,
  partitionSymbolPage,
  SYNC_RUN_TIME_BUDGET_MS,
  MAX_SYNC_CHAIN_DEPTH,
  isWithinSyncRunBudget,
  normalizeSyncChainDepth,
  shouldChainAnotherSyncBatch,
  resolveEnabledLegs,
  describeSyncShortfall,
  NSE_ANNOUNCEMENT_DOC_TYPES,
  SCREENER_PAGE_DOC_TYPES,
} from "../../../../workers/src/processors/stock-document-sync-logic";
// MONEY-1255 — the extension and the stored mimeType must be ONE decision.
import {
  normalizeDocMimeType,
  initialProcessingStatus,
} from "@usemoney/core/market-data/doc-mime";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Workers - Processor: Stock Document Sync", () => {
  describe("Constants (real exports)", () => {
    it("DELAY_BETWEEN_SYMBOLS_MS should be 2000", () => {
      assert.strictEqual(DELAY_BETWEEN_SYMBOLS_MS, 2000);
    });

    it("NSE_BASE should be https://www.nseindia.com", () => {
      assert.strictEqual(NSE_BASE, "https://www.nseindia.com");
    });

    it("API_LIMITS values", () => {
      assert.strictEqual(API_LIMITS.tickertape, 5000);
      assert.strictEqual(API_LIMITS.nse, 2000);
      assert.strictEqual(API_LIMITS.screener, 500); // MONEY-853: lowered from 2000 (429 limit)
      assert.strictEqual(API_LIMITS.gcsUploads, 10000);
    });
  });

  describe("extractPeriod (real export)", () => {
    const base = { title: "", filingDate: new Date("2026-03-15") };

    it("extracts Q1-2026 from a quarterly title", () => {
      assert.strictEqual(
        extractPeriod({ ...base, title: "Q1 2026 Financial Results" }),
        "Q1-2026"
      );
    });

    it("extracts Q4-2025 with a dash separator", () => {
      assert.strictEqual(
        extractPeriod({ ...base, title: "Q4-2025 Quarterly Results" }),
        "Q4-2025"
      );
    });

    it("extracts Q2-2026 with an en-dash separator", () => {
      assert.strictEqual(
        extractPeriod({ ...base, title: "Q2–2026 Results" }),
        "Q2-2026"
      );
    });

    it("extracts FY2026 / FY2025 (with optional space)", () => {
      assert.strictEqual(
        extractPeriod({ ...base, title: "Annual Report FY2026" }),
        "FY2026"
      );
      assert.strictEqual(
        extractPeriod({ ...base, title: "FY 2025 Annual Report" }),
        "FY2025"
      );
    });

    it("falls back to a zero-padded YYYY-MM-DD filing date", () => {
      assert.strictEqual(
        extractPeriod({
          title: "Board Meeting Outcome",
          filingDate: new Date("2026-01-05"),
        }),
        "2026-01-05"
      );
      assert.strictEqual(
        extractPeriod({
          title: "General announcement",
          filingDate: new Date("2026-03-05"),
        }),
        "2026-03-05"
      );
      assert.strictEqual(
        extractPeriod({
          title: "General announcement",
          filingDate: new Date("2026-11-02"),
        }),
        "2026-11-02"
      );
    });

    // MONEY-1536 — `filingDate` is an IST-correct instant now: an_dt
    // "23-Sep-2026 02:00:00" is 2026-09-22T20:30Z. Cloud Run runs in UTC, so
    // the case pins the process there.
    // Mutation: back to local `getFullYear/getMonth/getDate` -> RED
    // ("2026-09-22", the day BEFORE the filing's IST day).
    it("falls back to the filing's IST day, even in a UTC process", () => {
      const prev = process.env.TZ;
      process.env.TZ = "UTC";
      try {
        assert.strictEqual(
          extractPeriod({
            title: "Board Meeting Outcome",
            filingDate: new Date("2026-09-22T20:30:00Z"),
          }),
          "2026-09-23"
        );
      } finally {
        if (prev === undefined) delete process.env.TZ;
        else process.env.TZ = prev;
      }
    });

    it("INVALID-DATE GUARD: an Invalid filingDate yields 'unknown-date', never 'NaN-NaN-NaN'", () => {
      // Before the guard this produced "NaN-NaN-NaN", a corrupt period that
      // became part of the GCS path + the stockDocument unique key.
      const period = extractPeriod({
        title: "No quarter or FY here",
        filingDate: new Date("not a date"),
      });
      assert.strictEqual(period, "unknown-date");
      assert.ok(!period.includes("NaN"));
    });

    it("a Q/FY title still wins even when the date is invalid", () => {
      assert.strictEqual(
        extractPeriod({ title: "Q3 2025 Results", filingDate: new Date(NaN) }),
        "Q3-2025"
      );
    });
  });

  describe("cleanSymbol (real export)", () => {
    it("strips .NS / .BO and uppercases", () => {
      assert.strictEqual(cleanSymbol("TCS.NS"), "TCS");
      assert.strictEqual(cleanSymbol("RELIANCE.BO"), "RELIANCE");
      assert.strictEqual(cleanSymbol("tcs.ns"), "TCS");
    });

    it("leaves a suffix-less symbol intact and keeps '&'", () => {
      assert.strictEqual(cleanSymbol("INFY"), "INFY");
      assert.strictEqual(cleanSymbol("M&M.NS"), "M&M");
    });
  });

  describe("isValidEquitySymbol (real export)", () => {
    it("accepts genuine equities (TCS / RELIANCE / M&M / BSE)", () => {
      assert.strictEqual(isValidEquitySymbol("TCS"), true);
      assert.strictEqual(isValidEquitySymbol("RELIANCE"), true);
      assert.strictEqual(isValidEquitySymbol("M&M"), true);
      assert.strictEqual(isValidEquitySymbol("BSE"), true); // BSE Ltd, a real stock
    });

    it("rejects excluded index symbols", () => {
      for (const s of ["NIFTY", "NIFTY50", "BANKNIFTY", "SENSEX"]) {
        assert.strictEqual(isValidEquitySymbol(s), false, s);
      }
    });

    it("rejects excluded patterns (LIQUIDBEES, NIFTY+digit)", () => {
      assert.strictEqual(isValidEquitySymbol("LIQUIDBEES"), false);
      assert.strictEqual(isValidEquitySymbol("NIFTY1"), false);
    });

    it("rejects malformed tickers (lowercase start, single char)", () => {
      assert.strictEqual(isValidEquitySymbol("tcs"), false);
      assert.strictEqual(isValidEquitySymbol("A"), false);
    });
  });

  describe("isWithinApiLimit (real export)", () => {
    it("allows below limit, rejects at/over (strict <)", () => {
      assert.strictEqual(isWithinApiLimit("tickertape", 0), true);
      assert.strictEqual(isWithinApiLimit("nse", 1999), true);
      assert.strictEqual(isWithinApiLimit("nse", 2000), false);
      assert.strictEqual(isWithinApiLimit("screener", 3000), false);
    });
  });

  describe("normalizeScreenerDocType (real export)", () => {
    it("keeps the valid Screener doc types verbatim", () => {
      for (const t of [
        "concall_transcript",
        "concall_ppt",
        "annual_report",
        "drhp",
      ]) {
        assert.strictEqual(normalizeScreenerDocType(t), t);
      }
    });

    it("maps unknown / empty to corporate_filing", () => {
      assert.strictEqual(
        normalizeScreenerDocType("investor_presentation"),
        "corporate_filing"
      );
      assert.strictEqual(normalizeScreenerDocType(""), "corporate_filing");
    });
  });

  describe("inferExtension (real export)", () => {
    it("pdf for pdf content types, txt for text, pdf otherwise", () => {
      assert.strictEqual(inferExtension("application/pdf"), "pdf");
      assert.strictEqual(inferExtension("text/plain"), "txt");
      assert.strictEqual(inferExtension("text/html"), "txt");
      assert.strictEqual(inferExtension("application/octet-stream"), "pdf");
    });

    // ── MONEY-1255 ──────────────────────────────────────────────────
    //
    // This function and the stored `mimeType` used to be two independent
    // statements of one rule. `inferExtension` tested a SUBSTRING, so
    // `application/pdf;charset=UTF-8` produced a correctly-named `.pdf` object;
    // the column kept the parameterised spelling and the extract query — an
    // exact match — could never select the row. A right filename beside an
    // unreachable row, which is why nothing looked broken.

    it("handles PARAMETERISED headers, which is what the wire actually sends", () => {
      assert.strictEqual(
        inferExtension("application/pdf;charset=UTF-8"),
        "pdf"
      );
      assert.strictEqual(inferExtension("text/html; charset=UTF-8"), "txt");
      assert.strictEqual(inferExtension("TEXT/HTML;charset=utf-8"), "txt");
    });

    it("agrees with normalizeDocMimeType on EVERY prod spelling", () => {
      // The invariant that was violated, stated in the direction that matters:
      // a row the column calls a PDF must have a `.pdf` object, and a row given
      // a `.txt` object must not be one. The converse does NOT hold and must
      // not be asserted — `inferExtension` has a catch-all `else → "pdf"`, so
      // `audio/mpeg` and `application/octet-stream` also land on `.pdf`. That
      // catch-all is pre-existing, harmless (the extension only names a GCS
      // key), and load-bearing for the unknown-type case.
      for (const raw of [
        "application/pdf",
        "application/pdf;charset=UTF-8",
        "text/html; charset=UTF-8",
        "text/html; charset=utf-8",
        "text/html;charset=UTF-8",
        "text/html;charset=utf-8",
        "text/html",
        "audio/mpeg",
        "application/zip",
        "",
      ]) {
        const ext = inferExtension(raw);
        const mime = normalizeDocMimeType(raw);
        if (mime === "application/pdf") {
          assert.strictEqual(
            ext,
            "pdf",
            `${JSON.stringify(raw)}: column says PDF but the object is .${ext}`
          );
        }
        if (ext === "txt") {
          assert.notStrictEqual(
            mime,
            "application/pdf",
            `${JSON.stringify(raw)}: object is .txt but the column says PDF`
          );
        }
      }
    });

    it("an empty header keeps the schema default in both places", () => {
      assert.strictEqual(inferExtension(""), "pdf");
      assert.strictEqual(normalizeDocMimeType(""), "application/pdf");
    });
  });

  describe("MONEY-1255 — the Screener write site stores the NORMALIZED value", () => {
    // A source scan, deliberately. `storeScreenerDoc` is I/O-bound (ky + GCS +
    // Prisma) and untested at that layer by design; what has to be pinned is
    // that the value reaching `mimeType` passed through the normalizer, because
    // the previous version stored `resp.headers.get("content-type")` verbatim
    // and that is a one-token regression to make again.
    // `__dirname`, not `import.meta.dirname` — this workspace's tsx transform
    // leaves the latter undefined, and `join(undefined, …)` throws inside the
    // describe callback, which node reports as a dropped suite. Same resolution
    // the sibling meta guards use.
    const src = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "workers",
        "src",
        "processors",
        "stock-document-sync.ts"
      ),
      "utf8"
    );

    it("[meta] the file is the one that stores Screener documents", () => {
      assert.ok(src.includes("async function storeScreenerDoc"), "wrong file");
      assert.ok(src.length > 20_000, "the read is truncated");
    });

    it("the raw header is read into a name that says it is raw", () => {
      // Whitespace-tolerant on purpose (MONEY-1255): the expression is the
      // claim, the line breaks are not. `workers/**` is NOT in lint-staged's
      // prettier scope (only `apps/**` and `packages/**` are), so this line
      // sits at 81 columns and ANY formatter run rewraps it — which would fail
      // this assertion while the code it describes was untouched.
      assert.match(
        src,
        /const rawContentType\s*=\s*resp\.headers\.get\("content-type"\)\s*\|\|\s*"application\/pdf";/
      );
    });

    it("mimeType comes from the BYTES, and status from the same value", () => {
      // MONEY-1319 — this asserted `normalizeDocMimeType(rawContentType)`, and
      // that was the whole MONEY-1255 fix: a header is a media type PLUS
      // parameters, and the exact-match query missed `;charset=UTF-8`. The
      // header is still the input, and it is no longer the AUTHORITY: this leg
      // wrote TEN of the 13 measured rows where the stored type and the bytes
      // disagree (`text/html` over something that is not HTML), and a
      // header-keyed selection would have blanked the gcsPath of ten documents
      // we hold. `resolveStoredMimeType` sniffs the body and falls back to
      // exactly `normalizeDocMimeType(rawContentType)` when the bytes cannot be
      // identified — so the MONEY-1255 property is preserved, not replaced.
      //
      // `undecidable: "trust-header"` is REQUIRED here and is the only place in
      // the repo that asks for it (MONEY-1319 review, M8). The default refuses
      // to let an uncorroborated header park a row in a terminal status; this
      // leg is the one where that was already the behaviour and is intended —
      // Screener's `text/html` for a SEBI landing page and its `audio/mpeg` for
      // a concall recording are honest, and 1,210 rows sat PENDING for an
      // extractor that will never read them. Dropping the argument here would
      // silently re-queue that pile.
      assert.match(
        src,
        /const contentType = resolveStoredMimeType\(\{\s*body: buffer,\s*contentType: rawContentType,\s*undecidable: "trust-header",\s*\}\);/
      );
      assert.match(
        src,
        /const status = initialProcessingStatus\(contentType\);/
      );
      // …and the object NAME must come from the same resolved value, or the
      // filename and the column decide separately and disagree — which IS the
      // MONEY-1255 defect, one layer in.
      assert.match(src, /const ext = inferExtension\(contentType\);/);
      // Both arms of the upsert. The UPDATE arm used to hard-code PENDING and
      // never touch mimeType, so a re-fetch re-queued the row under the old
      // spelling — the repair would have been undone by the next weekly sync.
      const upsertArms = src.match(/processingStatus: status,/g) ?? [];
      assert.strictEqual(
        upsertArms.length,
        2,
        "both the create AND the update arm must take the computed status"
      );
      const mimeArms = src.match(/mimeType: contentType,/g) ?? [];
      assert.strictEqual(
        mimeArms.length,
        2,
        "both arms must write the normalized mimeType"
      );
    });

    it("the GCS object still carries the RAW header", () => {
      // Provenance for the bytes. GCS metadata is never matched on, so nothing
      // breaks by keeping it, and dropping it would lose the only record of
      // what was actually served.
      assert.match(
        src,
        /uploadToGCS\(\s*gcsPath,\s*buffer,\s*rawContentType,?\s*\)/
      );
    });

    it("a Screener HTML error page is never queued as work", () => {
      // The rule the write site now applies, executed rather than scanned.
      assert.strictEqual(
        initialProcessingStatus("text/html; charset=UTF-8"),
        "UNSUPPORTED"
      );
      assert.strictEqual(
        initialProcessingStatus("application/pdf;charset=UTF-8"),
        "PENDING"
      );
    });
  });

  describe("buildNseUrl (real export)", () => {
    it("returns absolute (http/https) URLs unchanged", () => {
      assert.strictEqual(
        buildNseUrl("https://www.nseindia.com/api/reports/file.pdf"),
        "https://www.nseindia.com/api/reports/file.pdf"
      );
      assert.strictEqual(
        buildNseUrl("http://example.com/file.pdf"),
        "http://example.com/file.pdf"
      );
    });

    it("prepends NSE_BASE to a relative path", () => {
      assert.strictEqual(
        buildNseUrl("/api/reports/file.pdf"),
        "https://www.nseindia.com/api/reports/file.pdf"
      );
    });
  });

  // ── Citation URL builders (MONEY-784 P3b) ────────────────────────────────

  describe("buildScreenerUrl (real export)", () => {
    it("builds the Screener company URL from the symbol (uppercased, trailing slash)", () => {
      assert.strictEqual(
        buildScreenerUrl("RELIANCE"),
        "https://www.screener.in/company/RELIANCE/"
      );
      assert.strictEqual(
        buildScreenerUrl("tcs"),
        "https://www.screener.in/company/TCS/"
      );
    });
  });

  describe("buildTickertapeUrl (real export)", () => {
    it("uses the sid suffix when a sid is present", () => {
      assert.strictEqual(
        buildTickertapeUrl("RELIANCE", "RELI"),
        "https://www.tickertape.in/stocks/-RELI"
      );
      // Trims whitespace around the sid.
      assert.strictEqual(
        buildTickertapeUrl("TCS", "  TCS  "),
        "https://www.tickertape.in/stocks/-TCS"
      );
    });

    it("falls back to a symbol-keyed search URL when sid is missing/blank", () => {
      assert.strictEqual(
        buildTickertapeUrl("RELIANCE", null),
        "https://www.tickertape.in/stocks?ticker=RELIANCE"
      );
      assert.strictEqual(
        buildTickertapeUrl("infy"),
        "https://www.tickertape.in/stocks?ticker=INFY"
      );
      assert.strictEqual(
        buildTickertapeUrl("HDFC", "   "),
        "https://www.tickertape.in/stocks?ticker=HDFC"
      );
    });
  });

  // ── boundSymbolBatch / MAX_SYMBOLS_PER_RUN (page size + runaway guard) ────
  // A caller must never be able to push "all 8,000 equities" into one run. This
  // is the PAGE SIZE; what bounds the run in TIME is SYNC_RUN_TIME_BUDGET_MS,
  // asserted in its own block below.

  describe("boundSymbolBatch / MAX_SYMBOLS_PER_RUN (real export)", () => {
    const big = Array.from({ length: 8000 }, (_, i) => `SYM${i}`);

    it("MAX_SYMBOLS_PER_RUN is a sane positive page size", () => {
      // MONEY-1255 — this used to assert `MAX_SYMBOLS_PER_RUN <= 600` under the
      // comment "terminates in <600s". That is a SYMBOL COUNT checked against a
      // SECOND COUNT: the two units are unrelated, and the claim was false in
      // the direction that mattered. At 250 symbols the run slept
      // 249 x 2,000ms + 250 x 3,000ms = 1,248s — more than double the deadline
      // the assertion claimed to protect — and the number would have passed at
      // 600 symbols, i.e. 3,000s. A count cannot express a time bound; the
      // budget-vs-deadline arithmetic below can, and does.
      assert.ok(Number.isInteger(MAX_SYMBOLS_PER_RUN));
      assert.ok(MAX_SYMBOLS_PER_RUN > 0);
      assert.strictEqual(MAX_SYMBOLS_PER_RUN, 250);
    });

    it("clamps an 8,000-symbol list to MAX_SYMBOLS_PER_RUN", () => {
      const out = boundSymbolBatch(big);
      assert.strictEqual(out.length, MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(out[0], "SYM0"); // head kept (sorted by analysisCount)
    });

    it("a default batchSize of 10,000 still clamps to the hard cap", () => {
      assert.strictEqual(
        boundSymbolBatch(big, 10_000).length,
        MAX_SYMBOLS_PER_RUN
      );
    });

    it("honours a SMALLER caller batchSize", () => {
      assert.strictEqual(boundSymbolBatch(big, 10).length, 10);
    });

    it("returns the list unchanged when already within the cap", () => {
      const small = ["TCS", "INFY", "RELIANCE"];
      const out = boundSymbolBatch(small, 10_000);
      assert.deepStrictEqual(out, small);
    });

    it("falls back to the hard cap for a non-finite / non-positive batchSize", () => {
      assert.strictEqual(
        boundSymbolBatch(big, NaN).length,
        MAX_SYMBOLS_PER_RUN
      );
      assert.strictEqual(boundSymbolBatch(big, 0).length, MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(boundSymbolBatch(big, -5).length, MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(
        boundSymbolBatch(big, Infinity).length,
        MAX_SYMBOLS_PER_RUN
      );
    });

    it("returns a copy (does not mutate / alias the input)", () => {
      const small = ["TCS", "INFY"];
      const out = boundSymbolBatch(small);
      assert.notStrictEqual(out, small);
      assert.deepStrictEqual(out, small);
    });

    it("is a head slice of a CALLER-SUPPLIED list, which is all it may be", () => {
      // MONEY-1255. This test used to end with
      //
      //   // Re-running re-processes the SAME head (idempotent), never the tail.
      //   assert.deepStrictEqual(boundSymbolBatch(big), out);
      //
      // which pinned the defect as intended behaviour: the whole reason 76.3%
      // of active equities had no document is that consecutive runs processed
      // the identical head forever. The assertion itself was TRUE of this pure
      // function and always will be — a clamp of a list the caller handed us
      // cannot rotate, because it has no memory. What was wrong was the CLAIM
      // attached to it, that "re-running re-processes the same head" describes
      // the JOB.
      //
      // It no longer does. The discovered page is ordered stale-first on
      // `documentsSyncedAt` and every visited row is stamped, so consecutive
      // runs return DISJOINT batches — asserted against the real processor in
      // `workers/__tests__/processors/money1255-document-sync-rotation.test.ts`,
      // which is the only layer where "disjoint" is even expressible.
      //
      // What is asserted here is the narrow contract that remains: a head
      // slice, no carry-over, and the caller keeps ownership of the tail.
      const out = boundSymbolBatch(big);
      assert.strictEqual(out.length, MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(out[0], "SYM0");
      assert.strictEqual(out[out.length - 1], `SYM${MAX_SYMBOLS_PER_RUN - 1}`);
      assert.ok(!out.includes(`SYM${MAX_SYMBOLS_PER_RUN}`));
    });
  });

  // ── DEFECT 1: the batch never rotated ────────────────────────────────────

  describe("rotation — buildDocumentSyncOrderBy / buildDocumentSyncWhere", () => {
    it("orders STALE-FIRST on documentsSyncedAt, with a symbol tiebreak", () => {
      // The defect: `orderBy: { analysisCount: "desc" }` over a population where
      // analysisCount is 0 on ALL 10,444 active NSE equities. A constant sort
      // key resolves the same arbitrary order every run, nothing in the run
      // mutates it, and the same ~250 symbols are re-synced forever.
      assert.deepStrictEqual(buildDocumentSyncOrderBy(), [
        { documentsSyncedAt: "asc" },
        { symbol: "asc" },
      ]);
    });

    it("the tiebreak is REQUIRED, not decoration", () => {
      // On the first run every row shares one marker value (absent), so without
      // a second key the order within that value is unspecified and two
      // consecutive pages may overlap arbitrarily.
      const order = buildDocumentSyncOrderBy();
      assert.strictEqual(order.length, 2);
      assert.deepStrictEqual(order[1], { symbol: "asc" });
    });

    it("NEVER filters on documentsSyncedAt — the Mongo absent-field trap", () => {
      // `prisma db push` creates indexes, never fields, so documentsSyncedAt is
      // ABSENT (not null) on every pre-existing row. Prisma's Mongo connector
      // does not treat absent as null, so BOTH `{ documentsSyncedAt: null }`
      // and `{ documentsSyncedAt: { not: null } }` match ZERO rows — the
      // population would silently become empty. MONEY-1050 / 1205 / 1234 / 1236.
      //
      // The defence is structural: the marker may appear in the orderBy and
      // nowhere else. Ordering has no such hazard (Mongo sorts a missing field
      // lowest, so an unstamped row sorts FIRST under asc — exactly right).
      for (const tickertapeOnly of [true, false]) {
        const where = buildDocumentSyncWhere(tickertapeOnly);
        assert.ok(
          !JSON.stringify(where).includes("documentsSyncedAt"),
          "the rotation marker must never appear in the WHERE clause"
        );
      }
    });

    it("selects active NSE+BSE equities, and gates on the sid only for the TT-only schedule", () => {
      const all = buildDocumentSyncWhere(false);
      assert.strictEqual(all.isActive, true);
      assert.strictEqual(all.instrumentType, "EQUITY");
      assert.deepStrictEqual(all.exchange, { in: ["NSE", "BSE"] });
      assert.strictEqual(all.OR, undefined);

      const tt = buildDocumentSyncWhere(true);
      assert.deepStrictEqual(tt.OR, [
        { tickertapeSid: { not: null } },
        { analysisCount: { gt: 0 } },
      ]);
    });

    it("isTickertapeOnlyRun matches the tickertape-daily schedule payload", () => {
      // scripts/ops/setup-scheduler.sh sends exactly this.
      assert.strictEqual(isTickertapeOnlyRun(["financial_statement"]), true);
      assert.strictEqual(isTickertapeOnlyRun(undefined), false);
      assert.strictEqual(isTickertapeOnlyRun([]), false);
      assert.strictEqual(
        isTickertapeOnlyRun(["financial_statement", "annual_report"]),
        false
      );
    });
  });

  describe("resolveSymbolPageSize — the number the chain compares against", () => {
    it("clamps the scheduler's batchSize:8000 to the page cap", () => {
      // Not cosmetic: `shouldChainAnotherSyncBatch` reads `rowsSelected <
      // pageSize` as "the table ran dry". Passing take:8000 and clamping in
      // code afterwards would make a full 250-row page look drained and stop
      // the chain after one link, every night, silently.
      assert.strictEqual(resolveSymbolPageSize(8000), MAX_SYMBOLS_PER_RUN);
    });

    it("honours a smaller caller batchSize and defends against junk", () => {
      assert.strictEqual(resolveSymbolPageSize(10), 10);
      assert.strictEqual(resolveSymbolPageSize(undefined), MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(resolveSymbolPageSize(NaN), MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(resolveSymbolPageSize(0), MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(resolveSymbolPageSize(-5), MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(resolveSymbolPageSize(Infinity), MAX_SYMBOLS_PER_RUN);
      assert.strictEqual(resolveSymbolPageSize(7.9), 7);
    });
  });

  describe("partitionSymbolPage — exchange survives selection (DEFECT 3)", () => {
    it("prefers the NSE listing for a dual-listed symbol", () => {
      const { eligible } = partitionSymbolPage([
        { symbol: "TCS", exchange: "BSE" },
        { symbol: "TCS", exchange: "NSE" },
      ]);
      assert.strictEqual(eligible.length, 1);
      assert.deepStrictEqual(eligible[0], { symbol: "TCS", exchange: "NSE" });
    });

    it("is order-independent — NSE wins whichever row came first", () => {
      const { eligible } = partitionSymbolPage([
        { symbol: "TCS", exchange: "NSE" },
        { symbol: "TCS", exchange: "BSE" },
      ]);
      assert.deepStrictEqual(eligible, [{ symbol: "TCS", exchange: "NSE" }]);
    });

    it("KEEPS a BSE-only symbol, carrying its real exchange", () => {
      // The old code discarded the exchange (`select: { symbol: true }`) and
      // hardcoded "NSE", so a BSE-only symbol was looked up on the wrong
      // exchange, missed, and dropped with no log and no counter — having
      // consumed one of the page's 250 slots.
      const { eligible } = partitionSymbolPage([
        { symbol: "SMALLCO", exchange: "BSE" },
      ]);
      assert.deepStrictEqual(eligible, [
        { symbol: "SMALLCO", exchange: "BSE" },
      ]);
    });

    it("separates excluded symbols instead of silently dropping them", () => {
      // They must be reported so the caller can STAMP them: an unstamped
      // excluded row leads a stale-first page on every run forever.
      const { eligible, excluded } = partitionSymbolPage([
        { symbol: "NIFTY", exchange: "NSE" },
        { symbol: "LIQUIDBEES", exchange: "NSE" },
        { symbol: "INFY", exchange: "NSE" },
      ]);
      assert.deepStrictEqual(eligible, [{ symbol: "INFY", exchange: "NSE" }]);
      assert.deepStrictEqual(excluded.sort(), ["LIQUIDBEES", "NIFTY"]);
    });

    it("an excluded symbol is never also eligible", () => {
      const { eligible, excluded } = partitionSymbolPage([
        { symbol: "NIFTY", exchange: "NSE" },
        { symbol: "NIFTY", exchange: "BSE" },
      ]);
      assert.deepStrictEqual(eligible, []);
      assert.deepStrictEqual(excluded, ["NIFTY"]);
    });
  });

  // ── DEFECT 2: the run could not finish inside the ack deadline ───────────

  describe("throughput — the 600s Pub/Sub ack deadline", () => {
    const ACK_DEADLINE_MS = 600_000;

    it("the OLD design could not fit, and the arithmetic says so", () => {
      // 249 inter-symbol sleeps + 250 Screener self-throttles, before one HTTP
      // round trip, against a deadline that is Pub/Sub's MAXIMUM.
      const SCREENER_THROTTLE_MS = 3_000;
      const sleeping =
        (MAX_SYMBOLS_PER_RUN - 1) * DELAY_BETWEEN_SYMBOLS_MS +
        MAX_SYMBOLS_PER_RUN * SCREENER_THROTTLE_MS;
      assert.strictEqual(sleeping, 1_248_000);
      assert.ok(
        sleeping > ACK_DEADLINE_MS * 2,
        "a full run slept for more than twice the ack deadline"
      );
    });

    it("budget + the worst in-flight unit still fits the deadline", () => {
      // The check sits BETWEEN units, so the true wall is `budget + one unit`.
      // Worst unit = a Screener page scrape carrying the full 429 ladder:
      // a 3s pre-delay, five fetches at the 20s API_TIMEOUT_MS, and four
      // backoffs of 5+10+20+40s.
      const WORST_IN_FLIGHT_MS = 3_000 + 5 * 20_000 + (5 + 10 + 20 + 40) * 1000;
      assert.strictEqual(WORST_IN_FLIGHT_MS, 178_000);
      const tail = DELAY_BETWEEN_SYMBOLS_MS + 4_000; // trailing sleep + bookkeeping
      assert.ok(
        SYNC_RUN_TIME_BUDGET_MS + WORST_IN_FLIGHT_MS + tail < ACK_DEADLINE_MS,
        "raising the budget without redoing this arithmetic must fail HERE, " +
          "not in production where the cost is a duplicated run"
      );
    });

    it("isWithinSyncRunBudget is a pure clock comparison", () => {
      assert.strictEqual(isWithinSyncRunBudget(0, 0), true);
      assert.strictEqual(
        isWithinSyncRunBudget(0, SYNC_RUN_TIME_BUDGET_MS - 1),
        true
      );
      assert.strictEqual(
        isWithinSyncRunBudget(0, SYNC_RUN_TIME_BUDGET_MS),
        false,
        "at exactly the budget the run must stop — not one unit past it"
      );
      assert.strictEqual(
        isWithinSyncRunBudget(0, SYNC_RUN_TIME_BUDGET_MS + 1),
        false
      );
      assert.strictEqual(isWithinSyncRunBudget(1_000, 1_500, 400), false);
    });

    it("normalizeSyncChainDepth cannot be talked into extra links", () => {
      assert.strictEqual(normalizeSyncChainDepth(undefined), 0);
      assert.strictEqual(normalizeSyncChainDepth(null), 0);
      assert.strictEqual(normalizeSyncChainDepth("5"), 0);
      assert.strictEqual(normalizeSyncChainDepth(NaN), 0);
      assert.strictEqual(normalizeSyncChainDepth(-3), 0);
      assert.strictEqual(normalizeSyncChainDepth(2.9), 2);
      assert.strictEqual(normalizeSyncChainDepth(3), 3);
      // A forged large value CLAMPS to the ceiling, which ENDS the chain
      // (chainDepth + 1 >= MAX) rather than wrapping it.
      assert.strictEqual(normalizeSyncChainDepth(1e9), MAX_SYNC_CHAIN_DEPTH);
      assert.strictEqual(
        shouldChainAnotherSyncBatch({
          rowsSelected: 250,
          pageSize: 250,
          chainDepth: normalizeSyncChainDepth(1e9),
          stamped: 250,
          explicitSymbols: false,
          upstreamCircuitBroken: false,
        }),
        false
      );
    });

    it("TERMINATES — an adversarial 'always more work' loop still ends", () => {
      // The environment lies in every direction that would extend a chain: the
      // page is always full, every row always stamps, nothing is ever forced.
      // Only the depth bound can stop it, which is the point: that bound is a
      // pure function of a number carried on the message and consults no
      // database, no clock and no queue.
      let depth = 0;
      let links = 0;
      while (
        shouldChainAnotherSyncBatch({
          rowsSelected: 250,
          pageSize: 250,
          chainDepth: depth,
          stamped: 250,
          explicitSymbols: false,
          upstreamCircuitBroken: false,
        })
      ) {
        depth += 1;
        links += 1;
        assert.ok(links <= MAX_SYNC_CHAIN_DEPTH * 4, "runaway chain");
      }
      assert.strictEqual(links, MAX_SYNC_CHAIN_DEPTH - 1);
      assert.strictEqual(depth + 1, MAX_SYNC_CHAIN_DEPTH);
    });

    it("every other stop condition ends the chain SOONER, never later", () => {
      const cont = {
        rowsSelected: 250,
        pageSize: 250,
        chainDepth: 0,
        stamped: 250,
        explicitSymbols: false,
        upstreamCircuitBroken: false,
      };
      assert.strictEqual(shouldChainAnotherSyncBatch(cont), true);
      // drained page
      assert.strictEqual(
        shouldChainAnotherSyncBatch({ ...cont, rowsSelected: 249 }),
        false
      );
      // NO PROGRESS — the runaway-poll shape: re-selecting the identical page.
      assert.strictEqual(
        shouldChainAnotherSyncBatch({ ...cont, stamped: 0 }),
        false
      );
      // a targeted run has no page to continue
      assert.strictEqual(
        shouldChainAnotherSyncBatch({ ...cont, explicitSymbols: true }),
        false
      );
      // chaining past a 429 circuit-break re-arms the breaker on a fresh run
      // and walks straight back into the tarpit — MONEY-853, one link later.
      assert.strictEqual(
        shouldChainAnotherSyncBatch({ ...cont, upstreamCircuitBroken: true }),
        false
      );
      // a non-positive page asked for nothing
      assert.strictEqual(
        shouldChainAnotherSyncBatch({
          ...cont,
          pageSize: 0,
          rowsSelected: 0,
        }),
        false
      );
    });
  });

  // ── DEFECT 5: the outcome permanently self-reported a dead source ────────

  describe("resolveEnabledLegs / describeSyncShortfall", () => {
    it("the weekly full sync enables all three legs", () => {
      assert.deepStrictEqual(resolveEnabledLegs(undefined), {
        tickertape: true,
        nse: true,
        screener: true,
      });
      assert.deepStrictEqual(resolveEnabledLegs([]), {
        tickertape: true,
        nse: true,
        screener: true,
      });
    });

    it("the tickertape-daily schedule gates BOTH NSE legs off by design", () => {
      // This is the whole reason the old condition was worthless: it flagged
      // `apiCalls.nse === 0`, which is TRUE on every healthy run of this
      // schedule. An alarm that is permanently asserted carries no information.
      assert.deepStrictEqual(resolveEnabledLegs(["financial_statement"]), {
        tickertape: true,
        nse: false,
        screener: false,
      });
    });

    it("an NSE announcement category enables the NSE leg", () => {
      for (const dt of NSE_ANNOUNCEMENT_DOC_TYPES) {
        assert.strictEqual(
          resolveEnabledLegs([dt]).nse,
          true,
          `${dt} must enable the NSE leg`
        );
      }
      assert.strictEqual(resolveEnabledLegs(["quarterly_result"]).nse, true);
    });

    it("any Screener-page doc type enables the Screener leg", () => {
      for (const dt of SCREENER_PAGE_DOC_TYPES) {
        assert.strictEqual(
          resolveEnabledLegs([dt]).screener,
          true,
          `${dt} must enable the Screener leg`
        );
      }
    });

    it("REGRESSION: a healthy tickertape-daily run reports NO shortfall", () => {
      // The old condition emitted "a source produced nothing: TT=250 NSE=0
      // SCR=0" here, every weekday, forever.
      const reason = describeSyncShortfall({
        selected: 250,
        written: 500,
        skippedFresh: 0,
        legs: resolveEnabledLegs(["financial_statement"]),
        wrote: { tickertape: 500, nse: 0, screener: 0 },
        transportFailures: 0,
        noNseListing: 0,
      });
      assert.strictEqual(reason, undefined);
    });

    it("reports a DARK leg only when the run enabled it", () => {
      const reason = describeSyncShortfall({
        selected: 250,
        written: 40,
        skippedFresh: 3,
        legs: { tickertape: true, nse: true, screener: true },
        wrote: { tickertape: 40, nse: 0, screener: 0 },
        transportFailures: 12,
        noNseListing: 0,
      });
      assert.match(String(reason), /enabled source\(s\) produced nothing/);
      assert.match(String(reason), /nse/);
      assert.match(
        String(reason),
        /screener/,
        "the old condition never checked screener at all, so a 429 " +
          "circuit-break — the failure it was written for — was invisible"
      );
      assert.match(String(reason), /12 upstream failure\(s\)/);
    });

    it("a total zero-write run says so, and carries the per-source WRITE counts", () => {
      const reason = describeSyncShortfall({
        selected: 250,
        written: 0,
        skippedFresh: 500,
        legs: { tickertape: true, nse: true, screener: true },
        wrote: { tickertape: 0, nse: 0, screener: 0 },
        transportFailures: 0,
        noNseListing: 7,
      });
      assert.match(
        String(reason),
        /no documents written from any enabled source/
      );
      assert.match(String(reason), /500 already fresh/);
      assert.match(String(reason), /7 symbol\(s\) with no NSE listing/);
    });

    it("an empty population is reported as a gate, not as a dark source", () => {
      assert.strictEqual(
        describeSyncShortfall({
          selected: 0,
          written: 0,
          skippedFresh: 0,
          legs: { tickertape: true, nse: true, screener: true },
          wrote: { tickertape: 0, nse: 0, screener: 0 },
          transportFailures: 0,
          noNseListing: 0,
        }),
        "population gate selected no symbols"
      );
    });
  });
});
