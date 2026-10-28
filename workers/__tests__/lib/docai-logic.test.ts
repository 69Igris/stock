/**
 * MONEY-1269 — `imagelessMode` on the Document AI request.
 *
 * The defect this pins is not a wrong number, it is an ABSENT field: without
 * `imagelessMode: true` the synchronous `processDocument` ceiling is 15 pages,
 * which is below the size of an ordinary results filing, and prod measured 59
 * of 59 calls failing in one 3-hour window with
 *
 *   3 INVALID_ARGUMENT: Document pages in non-imageless mode exceed the limit:
 *   15 got 16. Try using imageless mode to increase the limit to 30.
 *
 * It was invisible because `docai.ts` never throws: every failure degrades to
 * `{ text: null, degraded: true }` and the caller silently falls back to
 * `pdf-parse`. So there is nothing in the job's own outcome that a test could
 * have watched — the assertion has to be on the REQUEST.
 *
 * Asserted against the REAL `buildProcessRequest` (no shadow copy), and for
 * BOTH source shapes, because a flag set on one entry point and missed on the
 * other reproduces the bug for exactly one lane: the inline lane serves the 179
 * archive rows, the GCS lane serves everything else, and a half-fix would read
 * as a partial recovery.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker source under test.
import {
  buildProcessRequest,
  type DocumentAiProcessRequest,
} from "../../src/lib/docai-logic";

const PROCESSOR =
  "projects/stock-book-483718/locations/us/processors/abc123def456";

describe("MONEY-1269: buildProcessRequest", () => {
  describe("imagelessMode is set on EVERY request", () => {
    it("the gcsDocument shape carries imagelessMode: true", () => {
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "gcs", gcsUri: "gs://bucket/stocks/TCS/annual_report/x.pdf" },
        "application/pdf",
      );
      assert.strictEqual(
        req.imagelessMode,
        true,
        "without this the ceiling is 15 pages and every ordinary filing 400s",
      );
    });

    it("the rawDocument shape carries imagelessMode: true", () => {
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "bytes", content: Buffer.from("%PDF-1.4\n") },
        "application/pdf",
      );
      assert.strictEqual(
        req.imagelessMode,
        true,
        "the inline lane serves the MONEY-1319 archive rows — a flag set on " +
          "one entry point and missed on the other is a half-fix that reads " +
          "as a partial recovery",
      );
    });

    it("BOTH shapes agree, so neither call site can be the one that misses it", () => {
      const shapes: DocumentAiProcessRequest[] = [
        buildProcessRequest(
          PROCESSOR,
          { source: "gcs", gcsUri: "gs://b/k.pdf" },
          "application/pdf",
        ),
        buildProcessRequest(
          PROCESSOR,
          { source: "bytes", content: Buffer.alloc(4) },
          "application/pdf",
        ),
      ];
      for (const req of shapes) {
        assert.strictEqual(req.imagelessMode, true);
      }
      assert.strictEqual(
        new Set(shapes.map((r) => r.imagelessMode)).size,
        1,
        "the two entry points must not be able to disagree",
      );
    });
  });

  describe("the source shapes stay mutually exclusive", () => {
    it("gcs produces gcsDocument and NEVER rawDocument", () => {
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "gcs", gcsUri: "gs://bucket/a/b.pdf" },
        "application/pdf",
      );
      assert.deepStrictEqual(req.gcsDocument, {
        gcsUri: "gs://bucket/a/b.pdf",
        mimeType: "application/pdf",
      });
      assert.ok(
        !("rawDocument" in req),
        "the API rejects a request carrying both, and the type system does not",
      );
    });

    it("bytes produce rawDocument and NEVER gcsDocument", () => {
      // MONEY-1319: the recovered ZIP member exists only in memory — `gcsPath`
      // still names the ARCHIVE — so a gcsDocument here re-runs the exact
      // failure that left 126 of those rows FAILED.
      const content = Buffer.from("%PDF-1.7 inline");
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "bytes", content },
        "application/pdf",
      );
      assert.deepStrictEqual(req.rawDocument, {
        content,
        mimeType: "application/pdf",
      });
      assert.ok(!("gcsDocument" in req));
    });

    it("carries the processor name through verbatim", () => {
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "gcs", gcsUri: "gs://b/k.pdf" },
        "application/pdf",
      );
      assert.strictEqual(req.name, PROCESSOR);
    });

    it("carries the caller's mimeType, not a hardcoded PDF", () => {
      // `resolveExtractionSource` can hand us a member whose sniffed type is
      // not what the row claims; a hardcoded literal here would discard it.
      const req = buildProcessRequest(
        PROCESSOR,
        { source: "bytes", content: Buffer.alloc(1) },
        "image/tiff",
      );
      assert.strictEqual(req.rawDocument?.mimeType, "image/tiff");
    });
  });

  describe("the field is REAL on the installed client", () => {
    it("`imagelessMode` is declared on ProcessRequest in @google-cloud/documentai", async () => {
      // A guess that the vendor accepts an unknown field would fail silently:
      // gRPC drops unknown fields, so the request would go out WITHOUT the flag
      // and keep 400ing exactly as it does today, with a green test above it.
      // This reads the installed .d.ts so a dependency bump that removes the
      // field fails HERE rather than in prod at the next Document AI call.
      const { readFile } = await import("node:fs/promises");
      const { createRequire } = await import("node:module");
      const require_ = createRequire(import.meta.url);
      const protoPath = require_.resolve(
        "@google-cloud/documentai/build/protos/protos.d.ts",
      );
      const src = await readFile(protoPath, "utf-8");
      assert.ok(
        /ProcessRequest imagelessMode/.test(src) &&
          /imagelessMode\?: \(boolean\|null\);/.test(src),
        "the installed @google-cloud/documentai no longer declares " +
          "ProcessRequest.imagelessMode — the flag would be dropped silently",
      );
    });
  });
});
